import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Project, Capsule, SyncJob, SaveCapsuleInput } from '../domain/types';
import { parseCapsule } from '../ai/capsule';
import { makeSharingPreview } from '../domain/sharing';

const chronological = (a: Capsule, b: Capsule) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text.`);
}

interface RelayDB extends DBSchema {
  projects: { key: string; value: Project };
  capsules: { key: string; value: Capsule; indexes: { projectId: string } };
  jobs: { key: string; value: SyncJob; indexes: { projectId: string } };
}

export function createStore(name = 'relaytrace-v1') {
  let connection: Promise<IDBPDatabase<RelayDB>> | undefined;
  function database() {
    return connection ??= openDB<RelayDB>(name, 1, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('capsules', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      },
    });
  }
  return {
    async listProjects(): Promise<Project[]> { return (await database()).getAll('projects'); },
    async createProject(title: string, description = ''): Promise<Project> {
      requireText(title, 'Title');
      if (title.trim().length > 120) throw new Error('Title must be 120 characters or fewer.');
      if (typeof description !== 'string') throw new Error('Description must be text.');
      const now = new Date().toISOString();
      const project: Project = { id: crypto.randomUUID(), title: title.trim(), description, createdAt: now, updatedAt: now };
      await (await database()).add('projects', project);
      return project;
    },
    async getProject(id: string): Promise<Project | undefined> {
      requireText(id, 'Project ID');
      return (await database()).get('projects', id);
    },
    async listCapsules(projectId: string): Promise<Capsule[]> {
      requireText(projectId, 'Project ID');
      return (await (await database()).getAllFromIndex('capsules', 'projectId', projectId)).sort(chronological);
    },
    async saveCapsule(input: SaveCapsuleInput): Promise<Capsule> {
      if (!input || input.confirmed !== true) throw new Error('Explicit confirmation is required.');
      input = { ...input };
      requireText(input.projectId, 'Project ID');
      if (typeof input.originalNote !== 'string') throw new Error('Original note must be text.');
      if (input.source !== 'manual' && input.source !== 'on_device') throw new Error('Invalid capsule source.');
      if (input.photo !== undefined && (!(input.photo instanceof Blob) ||
        !['image/jpeg', 'image/png'].includes(input.photo.type) || input.photo.size === 0 ||
        input.photo.size > 8 * 1024 * 1024)) throw new Error('Photo must be a nonempty JPEG or PNG up to 8 MB.');
      if (!input.originalNote.trim() && !input.photo) throw new Error('A meaningful original note or photo is required.');
      if (input.photoName !== undefined && typeof input.photoName !== 'string') throw new Error('Photo name must be text.');
      const fields = parseCapsule(JSON.stringify(input.fields));
      const tx = (await database()).transaction(['projects', 'capsules'], 'readwrite');
      const project = await tx.objectStore('projects').get(input.projectId);
      if (!project) throw new Error('Project not found.');
      const previous = (await tx.objectStore('capsules').index('projectId').getAll(input.projectId)).sort(chronological).at(-1);
      const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0)).toISOString();
      const capsule: Capsule = {
        id: crypto.randomUUID(), projectId: project.id, parentId: previous?.id ?? null,
        createdAt: now, confirmedAt: now, originalNote: input.originalNote, fields, source: input.source,
        ...(input.photo ? { photo: input.photo } : {}),
        ...(input.photoName ? { photoName: input.photoName } : {}),
      };
      await tx.objectStore('capsules').add(capsule);
      await tx.objectStore('projects').put({ ...project, updatedAt: now });
      await tx.done;
      return capsule;
    },
    async enqueueSync(projectId: string, capsuleIds: string[], consent: boolean): Promise<SyncJob> {
      if (consent !== true) throw new Error('Explicit sharing consent is required.');
      requireText(projectId, 'Project ID');
      if (!Array.isArray(capsuleIds) || !capsuleIds.length) throw new Error('Select at least one capsule.');
      for (const id of capsuleIds) requireText(id, 'Capsule ID');
      const ids = [...new Set(capsuleIds)];
      const tx = (await database()).transaction(['projects', 'capsules', 'jobs'], 'readwrite');
      const project = await tx.objectStore('projects').get(projectId);
      if (!project) throw new Error('Project not found.');
      const capsules = await Promise.all(ids.map(id => tx.objectStore('capsules').get(id)));
      if (capsules.some(capsule => !capsule || capsule.projectId !== projectId)) throw new Error('Every capsule must belong to this project.');
      const job: SyncJob = {
        id: crypto.randomUUID(), projectId, approvedAt: new Date().toISOString(), status: 'pending', attempts: 0,
        payload: makeSharingPreview(project, capsules as Capsule[]),
      };
      await tx.objectStore('jobs').add(job);
      await tx.done;
      return job;
    },
    async listJobs(projectId?: string): Promise<SyncJob[]> {
      if (projectId !== undefined) requireText(projectId, 'Project ID');
      const db = await database();
      return projectId === undefined ? db.getAll('jobs') : db.getAllFromIndex('jobs', 'projectId', projectId);
    },
    async updateJob(id: string, patch: Partial<Pick<SyncJob, 'status' | 'attempts' | 'ownerId' | 'error'>>): Promise<SyncJob> {
      requireText(id, 'Job ID');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !['status', 'attempts', 'ownerId', 'error'].includes(key))) throw new Error('Only job delivery state can be updated.');
      patch = { ...patch };
      if ('status' in patch && !['pending', 'failed', 'synced'].includes(patch.status as string)) throw new Error('Invalid job status.');
      if ('attempts' in patch && (!Number.isSafeInteger(patch.attempts) || patch.attempts! < 0)) throw new Error('Attempts must be a nonnegative integer.');
      if ('ownerId' in patch) requireText(patch.ownerId, 'Owner ID');
      if ('error' in patch && patch.error !== undefined && typeof patch.error !== 'string') throw new Error('Error must be text.');
      const tx = (await database()).transaction('jobs', 'readwrite');
      const job = await tx.store.get(id);
      if (!job) throw new Error('Job not found.');
      if (job.ownerId !== undefined && 'ownerId' in patch && patch.ownerId !== job.ownerId) throw new Error('Job owner cannot change once bound.');
      if (patch.attempts !== undefined && patch.attempts < job.attempts) throw new Error('Attempts cannot decrease.');
      if (job.status === 'synced' && patch.status !== undefined && patch.status !== 'synced') throw new Error('Synced is a terminal status; transition refused.');
      const updated: SyncJob = { ...job, ...patch };
      if (updated.error === undefined) delete updated.error;
      await tx.store.put(updated);
      await tx.done;
      return updated;
    },
    async close(): Promise<void> { if (connection) { (await connection).close(); connection = undefined; } },
  };
}

export const store = createStore();
