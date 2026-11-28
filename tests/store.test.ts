import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/storage/store';
import type { SaveCapsuleInput } from '../src/domain/types';

const fields = () => ({ observation: ['Synthetic observation'], attempted: [], changed: [], result: [], unresolved: [], next_check: [] });
const input = (projectId: string): SaveCapsuleInput => ({ projectId, originalNote: 'Synthetic note', fields: fields(), confirmed: true, source: 'manual' });

it('atomically chains concurrent immutable capsules and preserves Blob across reopen', async () => {
  const name = `test-${crypto.randomUUID()}`;
  const db = createStore(name);
  const project = await db.createProject('Bench');
  const draft = input(project.id);
  const photo = new Blob(['synthetic image'], { type: 'image/png' });
  const first = await db.saveCapsule({ ...draft, photo, photoName: 'private.png', id: 'forged', parentId: 'forged' } as SaveCapsuleInput);
  draft.fields.observation.push('later edit');
  const [second, third] = await Promise.all([db.saveCapsule(input(project.id)), db.saveCapsule(input(project.id))]);
  expect(first.id).not.toBe('forged');
  expect(first.parentId).toBeNull();
  expect(second.parentId).toBe(first.id);
  expect(third.parentId).toBe(second.id);
  expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  await db.close();
  const reopened = createStore(name);
  const capsules = await reopened.listCapsules(project.id);
  expect(capsules.map(c => c.id)).toEqual([first.id, second.id, third.id]);
  expect(capsules[0].fields.observation).toEqual(['Synthetic observation']);
  expect(capsules[0].photo).toBeInstanceOf(Blob);
  expect(await capsules[0].photo!.text()).toBe('synthetic image');
  expect(capsules[0].photo!.type).toBe('image/png');
  expect(capsules[0].photoName).toBe('private.png');
  expect((await reopened.getProject(project.id))!.updatedAt).toBe(third.createdAt);
  await reopened.close();
});

it('rejects invalid approval, evidence, schema and project inputs without writes', async () => {
  const db = createStore(`test-${crypto.randomUUID()}`);
  const project = await db.createProject('Bench');
  const valid = input(project.id);
  const invalid: Array<Partial<SaveCapsuleInput>> = [
    { confirmed: false }, { confirmed: 'yes' as unknown as boolean },
    { originalNote: ' \n ' }, { source: 'cloud' as 'manual' },
    { projectId: 'absent' }, { projectId: '' },
    { fields: { ...fields(), result: [123] } as unknown as SaveCapsuleInput['fields'] },
    { fields: { ...fields(), extra: [] } as SaveCapsuleInput['fields'] },
    { photo: new Blob(['bad'], { type: 'image/gif' }) },
    { photo: new Blob([], { type: 'image/png' }) },
    { photo: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: 'image/jpeg' }) },
    { photo: { type: 'image/png', size: 1 } as Blob },
    { photoName: 7 as unknown as string }, { originalNote: null as unknown as string },
  ];
  for (const patch of invalid) await expect(db.saveCapsule({ ...valid, ...patch })).rejects.toThrow();
  for (const title of ['', '  ', null, 123]) await expect(db.createProject(title as string)).rejects.toThrow();
  await expect(db.createProject('Valid', null as unknown as string)).rejects.toThrow();
  expect(await db.listCapsules(project.id)).toEqual([]);
  expect(await db.getProject(project.id)).toEqual(project);
  expect(await db.listProjects()).toHaveLength(1);
  const photoOnly = await db.saveCapsule({ ...valid, originalNote: '', photo: new Blob(['synthetic'], { type: 'image/jpeg' }), source: 'on_device' });
  expect(photoOnly.originalNote).toBe('');
  await db.close();
});

it('queues only consented deduplicated project-owned immutable privacy snapshots', async () => {
  const name = `test-${crypto.randomUUID()}`;
  const db = createStore(name);
  const project = await db.createProject('Bench', 'Private description');
  const other = await db.createProject('Other');
  const first = await db.saveCapsule({ ...input(project.id), photo: new Blob(['private'], { type: 'image/png' }), photoName: 'private-name.png' });
  const foreign = await db.saveCapsule(input(other.id));
  await expect(db.enqueueSync(project.id, [first.id], false)).rejects.toThrow(/consent/i);
  await expect(db.enqueueSync(project.id, [first.id], 'true' as unknown as boolean)).rejects.toThrow(/consent/i);
  await expect(db.enqueueSync(project.id, [], true)).rejects.toThrow();
  await expect(db.enqueueSync(project.id, ['missing'], true)).rejects.toThrow();
  await expect(db.enqueueSync(project.id, [foreign.id], true)).rejects.toThrow();
  await expect(db.enqueueSync('missing', [first.id], true)).rejects.toThrow();
  expect(await db.listJobs()).toEqual([]);
  const job = await db.enqueueSync(project.id, [first.id, first.id], true);
  expect(job.status).toBe('pending');
  expect(job.attempts).toBe(0);
  expect(job.approvedAt).toBeTruthy();
  expect(job.payload.capsules).toHaveLength(1);
  expect(JSON.stringify(job.payload)).not.toMatch(/photo|private-name|Private description/i);
  const snapshot = structuredClone(job);
  job.payload.capsules[0].fields.observation.push('caller edit');
  await db.saveCapsule(input(project.id));
  expect(await db.listJobs(project.id)).toEqual([snapshot]);
  expect(await db.listJobs(other.id)).toEqual([]);
  await db.close();
  expect(await db.listJobs()).toEqual([snapshot]);
  await db.close();
});

it('updates retry state while preserving owner binding, consent and payload', async () => {
  const db = createStore(`test-${crypto.randomUUID()}`);
  const project = await db.createProject('Bench');
  const capsule = await db.saveCapsule(input(project.id));
  const job = await db.enqueueSync(project.id, [capsule.id], true);
  const failed = await db.updateJob(job.id, { status: 'failed', attempts: 1, ownerId: 'synthetic-owner', error: 'Synthetic offline failure' });
  expect(failed.status).toBe('failed');
  expect(failed.attempts).toBe(1);
  const badPatches = [
    { ownerId: 'other-owner' }, { ownerId: undefined }, { ownerId: '' },
    { payload: { secret: true } }, { approvedAt: 'forged' }, { projectId: 'forged' }, { id: 'forged' },
    { attempts: -1 }, { attempts: 0 }, { attempts: 1.5 }, { attempts: Infinity },
    { status: 'uploading' }, { error: 4 },
  ];
  for (const patch of badPatches) await expect(db.updateJob(job.id, patch as Parameters<typeof db.updateJob>[1])).rejects.toThrow();
  expect((await db.listJobs())[0]).toEqual(failed);
  const pending = await db.updateJob(job.id, { status: 'pending', error: undefined });
  expect(pending.error).toBeUndefined();
  const synced = await db.updateJob(job.id, { status: 'synced', attempts: 2, ownerId: 'synthetic-owner' });
  expect(synced.payload).toEqual(job.payload);
  expect(synced.approvedAt).toEqual(job.approvedAt);
  await expect(db.updateJob(job.id, { status: 'pending' })).rejects.toThrow(/transition|terminal/i);
  await expect(db.updateJob(job.id, { status: 'failed' })).rejects.toThrow(/transition|terminal/i);
  await expect(db.updateJob('missing', { attempts: 1 })).rejects.toThrow(/not found/i);
  await db.close();
  expect((await db.listJobs())[0]).toEqual(synced);
  await db.close();
});

it('serializes competing owner bindings so only one owner can claim a job', async () => {
  const db = createStore(`test-${crypto.randomUUID()}`);
  const project = await db.createProject('Bench');
  const capsule = await db.saveCapsule(input(project.id));
  const job = await db.enqueueSync(project.id, [capsule.id], true);
  const outcomes = await Promise.allSettled([
    db.updateJob(job.id, { ownerId: 'first-owner' }), db.updateJob(job.id, { ownerId: 'second-owner' }),
  ]);
  expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected']);
  expect((await db.listJobs())[0].ownerId).toBe('first-owner');
  await db.close();
});

it('captures approval inputs before awaiting persistence so caller mutations cannot alter records', async () => {
  const db = createStore(`test-${crypto.randomUUID()}`);
  const project = await db.createProject('Bench');
  const draft = input(project.id);
  const saving = db.saveCapsule(draft);
  draft.originalNote = 'changed after approval';
  draft.source = 'on_device';
  const capsule = await saving;
  expect(capsule.originalNote).toBe('Synthetic note');
  expect(capsule.source).toBe('manual');
  const job = await db.enqueueSync(project.id, [capsule.id], true);
  const patch: Parameters<typeof db.updateJob>[1] & { payload?: unknown } = { ownerId: 'approved-owner' };
  const updating = db.updateJob(job.id, patch);
  patch.ownerId = 'mutated-owner';
  patch.payload = { injected: true };
  const updated = await updating;
  expect(updated.ownerId).toBe('approved-owner');
  expect(updated.payload).toEqual(job.payload);
  expect((await db.listJobs())[0]).toEqual(updated);
  await db.close();
});

it('validates explicit lookup IDs instead of treating malformed filters as all records', async () => {
  const db = createStore(`test-${crypto.randomUUID()}`);
  for (const id of ['', '  ', null, 7]) {
    await expect(db.getProject(id as string)).rejects.toThrow();
    await expect(db.listCapsules(id as string)).rejects.toThrow();
    await expect(db.listJobs(id as string)).rejects.toThrow();
  }
  expect(await db.listJobs()).toEqual([]);
  await db.close();
});

describe('local projects', () => {
  it('accepts 120 trimmed title characters and rejects 121 without writes', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const db = createStore(name);
    try {
      const title = 'x'.repeat(120);
      const project = await db.createProject(`  ${title}  `);
      expect(project.title).toBe(title);
      for (const invalid of ['x'.repeat(121), `  ${'x'.repeat(121)}  `]) {
        await expect(db.createProject(invalid)).rejects.toThrow(/120/);
        expect(await db.listProjects()).toEqual([project]);
        expect(await db.listCapsules(project.id)).toEqual([]);
        expect(await db.listJobs()).toEqual([]);
      }
      await db.close();
      expect(await db.listProjects()).toEqual([project]);
    } finally {
      await db.close();
    }
  });

  it('persists projects across close and reopen without accepting caller IDs', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const db = createStore(name);
    const project = await db.createProject('  Synthetic bench  ', 'Synthetic notes');
    expect(project.title).toBe('Synthetic bench');
    expect(project.id).toBeTruthy();
    expect(project.createdAt).toBe(project.updatedAt);
    expect(await db.getProject(project.id)).toEqual(project);
    await db.close();
    const reopened = createStore(name);
    expect(await reopened.listProjects()).toEqual([project]);
    expect(await reopened.getProject('missing')).toBeUndefined();
    await reopened.close();
  });
});
