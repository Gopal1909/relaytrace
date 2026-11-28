import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncJob } from '../src/domain/types';
// Synthetic adapter fixtures only; Firebase network calls are mocked.
const m = vi.hoisted(() => ({ jobs: [] as SyncJob[], batches: [] as Array<Array<{ path: string; data: unknown }>>, read: vi.fn(), commit: vi.fn(), token: vi.fn() }));
vi.mock('../src/lib/firebase', () => ({ firebaseApp: {}, appCheck: {} }));
vi.mock('firebase/app-check', () => ({ getToken: m.token }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { uid: 'synthetic-owner' } }), signInAnonymously: vi.fn() }));
vi.mock('../src/storage/store', () => ({ store: {
  listJobs: vi.fn(async (projectId?: string) => structuredClone(m.jobs.filter(job => projectId === undefined || job.projectId === projectId))),
  updateJob: vi.fn(async (id: string, patch: object) => { const job = m.jobs.find(j => j.id === id)!; Object.assign(job, patch); return structuredClone(job); }),
} }));
vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}), doc: (base: { path?: string }, ...parts: string[]) => ({ path: [base.path, ...parts].filter(Boolean).join('/') }),
  writeBatch: () => { const writes: Array<{ path: string; data: unknown }> = []; m.batches.push(writes); return { set: (ref: { path: string }, data: unknown) => writes.push({ path: ref.path, data: structuredClone(data) }), commit: m.commit }; },
  getDocFromServer: m.read,
}));
import { store } from '../src/storage/store';
import { syncApprovedJobs } from '../src/sync/firebase-sync';
function approvedJob(suffix: string): SyncJob {
  const projectId = `project${suffix}`;
  return { id: `approval${suffix}`, projectId, approvedAt: '2026-11-16T00:00:00.000Z', status: 'pending', attempts: 0, payload: { schemaVersion: 1, project: { id: projectId, title: 'Synthetic' }, capsules: [{ id: `capsule${suffix}`, projectId, parentId: null, createdAt: '2026-11-16T00:00:00.000Z', confirmedAt: '2026-11-16T00:00:00.000Z', originalNote: 'Synthetic fixture', source: 'manual', fields: { observation: [], attempted: [], changed: [], result: [], unresolved: [], next_check: [] } }] } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); m.batches.length = 0;
  vi.stubGlobal('navigator', { onLine: true });
  m.jobs = [approvedJob('1')];
  m.token.mockResolvedValue({}); m.commit.mockResolvedValue(undefined);
  m.read.mockImplementation(async (ref: { path: string }) => {
    const receipt = m.batches.flat().filter(write => write.path === ref.path).at(-1);
    return { exists: () => receipt !== undefined, data: () => receipt?.data };
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
it('retries the same atomic snapshot if its committed receipt cannot initially be read back', async () => {
  m.read.mockRejectedValueOnce(new Error('Readback unavailable')).mockImplementation(async () => ({ exists: () => true, data: () => m.batches.at(-1)!.at(-1)!.data }));
  await expect(syncApprovedJobs()).resolves.toEqual({ synced: 0, failed: 1 });
  expect(m.jobs[0]).toMatchObject({ status: 'failed', attempts: 1, ownerId: 'synthetic-owner' });
  await expect(syncApprovedJobs()).resolves.toEqual({ synced: 1, failed: 0 });
  expect(m.jobs[0]).toMatchObject({ status: 'synced', attempts: 2, ownerId: 'synthetic-owner' });
  expect(m.batches).toHaveLength(2); expect(m.batches[1]).toEqual(m.batches[0]);
  expect(m.batches[0].map(x => x.path)).toEqual(['users/synthetic-owner/projects/project1', 'users/synthetic-owner/projects/project1/capsules/capsule1', 'users/synthetic-owner/approvals/approval1']);
  expect(m.commit).toHaveBeenCalledTimes(2);
});
it.each(['project1', 'project2'])('syncs only %s approvals without writing or updating the other project', async projectId => {
  m.jobs.push(approvedJob('2'));
  const selected = m.jobs.find(job => job.projectId === projectId)!;
  const other = m.jobs.find(job => job.projectId !== projectId)!;
  const untouched = structuredClone(other);

  await expect(syncApprovedJobs(projectId)).resolves.toEqual({ synced: 1, failed: 0 });

  expect(store.listJobs).toHaveBeenCalledTimes(1);
  expect(store.listJobs).toHaveBeenCalledWith(projectId);
  expect(m.batches).toHaveLength(1);
  expect(m.batches[0].map(write => write.path)).toEqual([
    `users/synthetic-owner/projects/${projectId}`,
    `users/synthetic-owner/projects/${projectId}/capsules/${selected.payload.capsules[0].id}`,
    `users/synthetic-owner/approvals/${selected.id}`,
  ]);
  expect(vi.mocked(store.updateJob).mock.calls.map(([id]) => id)).toEqual([selected.id, selected.id]);
  expect(selected).toMatchObject({ status: 'synced', attempts: 1, ownerId: 'synthetic-owner' });
  expect(other).toEqual(untouched);
});
it.each([
  { activeScope: 'project1', contenderScope: 'project2' },
  { activeScope: undefined, contenderScope: 'project1' },
  { activeScope: 'project1', contenderScope: undefined },
])('rejects competing scope $contenderScope without disturbing active scope $activeScope', async ({ activeScope, contenderScope }) => {
  m.jobs.push(approvedJob('2'));
  const commit = deferred();
  const started = deferred();
  m.commit.mockImplementationOnce(() => { started.resolve(); return commit.promise; });
  const active = syncApprovedJobs(activeScope);
  await started.promise;
  const jobsWhileActive = structuredClone(m.jobs);
  const writesWhileActive = structuredClone(m.batches);
  let contender: Promise<unknown> | undefined;
  try {
    expect(syncApprovedJobs(activeScope)).toBe(active);
    const outcome = vi.fn();
    contender = syncApprovedJobs(contenderScope).then(
      result => outcome({ result }),
      error => outcome({ error }),
    );
    await Promise.resolve();
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledWith({ error: expect.objectContaining({ message: 'A synchronization for a different project scope is already in progress.' }) });
    expect(syncApprovedJobs(activeScope)).toBe(active);
    expect(store.listJobs).toHaveBeenCalledTimes(1);
    expect(store.updateJob).toHaveBeenCalledTimes(1);
    expect(m.token).toHaveBeenCalledTimes(1);
    expect(m.commit).toHaveBeenCalledTimes(1);
    expect(m.read).not.toHaveBeenCalled();
    expect(m.jobs[0]).toMatchObject({ status: 'pending', attempts: 1, ownerId: 'synthetic-owner' });
    expect(m.jobs).toEqual(jobsWhileActive);
    expect(m.batches).toEqual(writesWhileActive);
  } finally {
    commit.resolve();
    await active;
    await contender;
  }
  await expect(active).resolves.toEqual({ synced: activeScope === undefined ? 2 : 1, failed: 0 });
  await expect(syncApprovedJobs(contenderScope)).resolves.toEqual({ synced: activeScope === undefined ? 0 : 1, failed: 0 });
  expect(store.listJobs).toHaveBeenCalledTimes(2);
  expect(m.commit).toHaveBeenCalledTimes(2);
  expect(m.jobs.every(job => job.status === 'synced' && job.attempts === 1)).toBe(true);
});
it('preserves no-argument global synchronization across approved projects', async () => {
  m.jobs.push(approvedJob('2'));
  const active = syncApprovedJobs();
  expect(syncApprovedJobs()).toBe(active);
  await expect(active).resolves.toEqual({ synced: 2, failed: 0 });
  expect(store.listJobs).toHaveBeenCalledTimes(1);
  expect(m.batches.map(batch => batch.map(write => write.path))).toEqual([
    ['users/synthetic-owner/projects/project1', 'users/synthetic-owner/projects/project1/capsules/capsule1', 'users/synthetic-owner/approvals/approval1'],
    ['users/synthetic-owner/projects/project2', 'users/synthetic-owner/projects/project2/capsules/capsule2', 'users/synthetic-owner/approvals/approval2'],
  ]);
  expect(vi.mocked(store.updateJob).mock.calls.map(([id]) => id)).toEqual(['approval1', 'approval1', 'approval2', 'approval2']);
  expect(m.jobs.every(job => job.status === 'synced' && job.attempts === 1 && job.ownerId === 'synthetic-owner')).toBe(true);
  expect(m.commit).toHaveBeenCalledTimes(2);
  expect(m.read).toHaveBeenCalledTimes(2);
});
it.each(['listing', 'App Check'])('releases the scope after %s rejects without touching either project', async failurePoint => {
  m.jobs.push(approvedJob('2'));
  const untouched = structuredClone(m.jobs);
  const failure = new Error(`${failurePoint} unavailable`);
  if (failurePoint === 'listing') vi.mocked(store.listJobs).mockRejectedValueOnce(failure);
  else m.token.mockRejectedValueOnce(failure);

  const active = syncApprovedJobs('project1');
  expect(syncApprovedJobs('project1')).toBe(active);
  await expect(active).rejects.toBe(failure);
  expect(m.jobs).toEqual(untouched);
  expect(store.updateJob).not.toHaveBeenCalled();
  expect(m.batches).toEqual([]);
  expect(m.commit).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();

  await expect(syncApprovedJobs('project2')).resolves.toEqual({ synced: 1, failed: 0 });
  expect(m.jobs[0]).toEqual(untouched[0]);
  expect(m.batches).toHaveLength(1);
  expect(m.batches[0][0].path).toBe('users/synthetic-owner/projects/project2');
  await expect(syncApprovedJobs('project1')).resolves.toEqual({ synced: 1, failed: 0 });
});
it.each(['commit', 'receipt'])('releases a failed scoped %s for another project before retrying the same snapshot', async failurePoint => {
  m.jobs.push(approvedJob('2'));
  const untouched = structuredClone(m.jobs[1]);
  const failure = new Error(`${failurePoint} unavailable`);
  if (failurePoint === 'commit') m.commit.mockRejectedValueOnce(failure);
  else m.read.mockRejectedValueOnce(failure);

  await expect(syncApprovedJobs('project1')).resolves.toEqual({ synced: 0, failed: 1 });
  expect(m.jobs[0]).toMatchObject({ status: 'failed', attempts: 1, ownerId: 'synthetic-owner' });
  expect(m.jobs[1]).toEqual(untouched);
  expect(m.batches).toHaveLength(1);
  expect(vi.mocked(store.updateJob).mock.calls.map(([id]) => id)).toEqual(['approval1', 'approval1']);

  await expect(syncApprovedJobs('project2')).resolves.toEqual({ synced: 1, failed: 0 });
  await expect(syncApprovedJobs('project1')).resolves.toEqual({ synced: 1, failed: 0 });
  expect(m.jobs[0]).toMatchObject({ status: 'synced', attempts: 2, ownerId: 'synthetic-owner' });
  expect(m.jobs[1]).toMatchObject({ status: 'synced', attempts: 1, ownerId: 'synthetic-owner' });
  expect(m.batches).toHaveLength(3);
  expect(m.batches[2]).toEqual(m.batches[0]);
});
