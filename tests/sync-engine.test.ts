import { expect, it, vi } from 'vitest';
import { processApprovedJobs } from '../src/sync/engine';
import type { SyncJob } from '../src/domain/types';
const fields = { observation: ['Synthetic'], attempted: [], changed: [], result: [], unresolved: [], next_check: [] };
const job = (): SyncJob => ({ id: 'job1', projectId: 'p1', approvedAt: '2026-11-16T00:00:00.000Z', status: 'pending', attempts: 0, payload: { schemaVersion: 1, project: { id: 'p1', title: 'Synthetic' }, capsules: [{ id: 'c1', projectId: 'p1', parentId: null, createdAt: '2026-11-16T00:00:00.000Z', confirmedAt: '2026-11-16T00:00:00.000Z', originalNote: 'Synthetic', fields, source: 'manual' }] } });
it('never authenticates or uploads when no approved job is pending', async () => {
  const auth = vi.fn(); const upload = vi.fn();
  await expect(processApprovedJobs({ list: async () => [], mark: vi.fn(), authenticate: auth, upload })).resolves.toEqual({ synced: 0, failed: 0 });
  expect(auth).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
});
it('binds approved snapshots to the authenticated owner before uploading and marks verified success', async () => {
  const events: unknown[] = []; const item = job();
  const result = await processApprovedJobs({ list: async () => [item], authenticate: async () => 'owner1', mark: async (_id, patch) => { events.push(patch); }, upload: async (owner, data) => { events.push({ owner, id: data.id }); } });
  expect(result).toEqual({ synced: 1, failed: 0 });
  expect(events[0]).toMatchObject({ ownerId: 'owner1', attempts: 1 });
  expect(events[1]).toEqual({ owner: 'owner1', id: 'job1' });
  expect(events[2]).toMatchObject({ status: 'synced' });
});
it('never sends another account’s previously bound approval', async () => {
  const item = { ...job(), ownerId: 'old-owner' }; const upload = vi.fn();
  const result = await processApprovedJobs({ list: async () => [item], mark: vi.fn(), authenticate: async () => 'new-owner', upload });
  expect(result.failed).toBe(1); expect(upload).not.toHaveBeenCalled();
});
it('retains failed transfers for an explicit retry without marking success', async () => {
  const mark = vi.fn();
  const result = await processApprovedJobs({ list: async () => [job()], mark, authenticate: async () => 'owner1', upload: async () => { throw new Error('Offline'); } });
  expect(result).toEqual({ synced: 0, failed: 1 });
  expect(mark.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'failed' });
});
it('rejects a corrupted approval carrying a photo before upload', async () => {
  const item = job(); (item.payload as unknown as Record<string, unknown>).photo = 'private'; const upload = vi.fn();
  const result = await processApprovedJobs({ list: async () => [item], mark: vi.fn(), authenticate: async () => 'owner1', upload });
  expect(result.failed).toBe(1); expect(upload).not.toHaveBeenCalled();
});
