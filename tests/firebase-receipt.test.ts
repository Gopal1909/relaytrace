import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncJob } from '../src/domain/types';

// Synthetic approval fixtures and mocked Firebase transport only; no live network or credentials.
const m = vi.hoisted(() => ({
  jobs: [] as SyncJob[],
  appCheck: {} as object | null,
  auth: { currentUser: { uid: 'synthetic-owner' } as { uid: string } | null, authStateReady: vi.fn() },
  getAuth: vi.fn(), signup: vi.fn(), token: vi.fn(), list: vi.fn(), update: vi.fn(),
  read: vi.fn(), doc: vi.fn(), batch: vi.fn(), set: vi.fn(), commit: vi.fn(),
}));
vi.mock('../src/lib/firebase', () => ({ firebaseApp: {}, get appCheck() { return m.appCheck; } }));
vi.mock('firebase/app-check', () => ({ getToken: m.token }));
vi.mock('firebase/auth', () => ({ getAuth: m.getAuth, signInAnonymously: m.signup }));
vi.mock('../src/storage/store', () => ({ store: { listJobs: m.list, updateJob: m.update } }));
vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}), doc: m.doc, writeBatch: m.batch, getDocFromServer: m.read,
}));
import { checkApprovedJobReceipt, syncApprovedJobs } from '../src/sync/firebase-sync';

function approvedJob(): SyncJob {
  return {
    id: 'synthetic-approval', projectId: 'synthetic-project', ownerId: 'synthetic-owner',
    approvedAt: '2026-11-16T00:00:00.000Z', status: 'pending', attempts: 1,
    payload: {
      schemaVersion: 1, project: { id: 'synthetic-project', title: 'Synthetic' },
      capsules: [{
        id: 'synthetic-capsule', projectId: 'synthetic-project', parentId: null,
        createdAt: '2026-11-16T00:00:00.000Z', confirmedAt: '2026-11-16T00:00:00.000Z',
        originalNote: 'Synthetic fixture only', source: 'manual',
        fields: { observation: [], attempted: [], changed: [], result: [], unresolved: [], next_check: [] },
      }],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function receipt(job = m.jobs[0]) {
  return {
    ownerId: job.ownerId, projectId: job.projectId, approvedAt: job.approvedAt,
    payloadHash: createHash('sha256').update(JSON.stringify(job.payload)).digest('hex'),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
  m.jobs = [approvedJob()]; m.appCheck = {};
  m.auth.currentUser = { uid: 'synthetic-owner' };
  m.auth.authStateReady.mockResolvedValue(undefined); m.getAuth.mockReturnValue(m.auth);
  m.list.mockImplementation(async (projectId?: string) => structuredClone(m.jobs.filter(job => projectId === undefined || job.projectId === projectId)));
  m.token.mockResolvedValue({ token: 'synthetic-mock-token' });
  m.doc.mockImplementation((_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }));
  m.batch.mockReturnValue({ set: m.set, commit: m.commit });
  m.commit.mockResolvedValue(undefined);
  m.read.mockImplementation(async () => ({ exists: () => true, data: () => receipt() }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('verifies the saved approval against its exact server receipt', async () => {
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .resolves.toEqual({ status: 'verified', jobId: 'synthetic-approval' });
  expect(m.list).toHaveBeenCalledWith('synthetic-project');
  expect(m.auth.authStateReady).toHaveBeenCalledOnce();
  expect(m.token).toHaveBeenCalledWith(m.appCheck, false);
  expect(m.read).toHaveBeenCalledExactlyOnceWith({ path: 'users/synthetic-owner/approvals/synthetic-approval' });
});

it('reports a missing server document without claiming no eventual write', async () => {
  const data = vi.fn();
  m.read.mockResolvedValueOnce({ exists: () => false, data });
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .resolves.toEqual({ status: 'missing', jobId: 'synthetic-approval' });
  expect(data).not.toHaveBeenCalled();
});

it.each(['ownerId', 'payloadHash', 'projectId', 'approvedAt'] as const)(
  'rejects a receipt whose %s differs from the immutable approval', async field => {
    m.read.mockResolvedValueOnce({ exists: () => true, data: () => ({ ...receipt(), [field]: 'synthetic-mismatch' }) });
    await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
      .rejects.toThrow('Cloud receipt does not match the approved job.');
  },
);

it.each([
  '', '.', '..', 'synthetic/path', 'synthetic project', 'x'.repeat(101),
  undefined, null, 42,
])('rejects malformed identifiers before local listing or Firebase access: %s', async invalid => {
  for (const [projectId, jobId] of [[invalid, 'synthetic-approval'], ['synthetic-project', invalid]]) {
    await expect(checkApprovedJobReceipt(projectId as string, jobId as string))
      .rejects.toThrow('Invalid approval identifiers.');
  }
  expect(m.list).not.toHaveBeenCalled();
  expect(m.getAuth).not.toHaveBeenCalled();
  expect(m.token).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
});

it.each([
  { name: 'absent approval', arrange: () => { m.jobs = []; } },
  { name: 'foreign scope returned by storage', arrange: () => {
    m.jobs[0].projectId = 'synthetic-foreign'; m.list.mockResolvedValueOnce(structuredClone(m.jobs));
  } },
  { name: 'different payload project', arrange: () => { m.jobs[0].payload.project.id = 'synthetic-foreign'; } },
  { name: 'different capsule project', arrange: () => { m.jobs[0].payload.capsules[0].projectId = 'synthetic-foreign'; } },
  { name: 'invalid payload', arrange: () => { m.jobs[0].payload.project.title = ''; } },
  { name: 'unapproved payload field', arrange: () => { Object.assign(m.jobs[0].payload, { photo: 'synthetic-private' }); } },
  { name: 'absent approval time', arrange: () => { delete (m.jobs[0] as Partial<SyncJob>).approvedAt; } },
  { name: 'invalid approval time', arrange: () => { m.jobs[0].approvedAt = 'synthetic-not-a-date'; } },
  { name: 'non-string approval time', arrange: () => { m.jobs[0].approvedAt = 1 as unknown as string; } },
  { name: 'unbound owner', arrange: () => { delete m.jobs[0].ownerId; } },
  { name: 'empty owner', arrange: () => { m.jobs[0].ownerId = ''; } },
  { name: 'path-like owner', arrange: () => { m.jobs[0].ownerId = 'synthetic/owner'; } },
  { name: 'non-string owner', arrange: () => { m.jobs[0].ownerId = 1 as unknown as string; } },
  { name: 'oversized owner', arrange: () => { m.jobs[0].ownerId = 'x'.repeat(129); } },
])('rejects $name before any Firebase access', async ({ arrange }) => {
  arrange();
  const untouched = structuredClone(m.jobs);
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .rejects.toThrow('Saved approval is unavailable or invalid.');
  expect(m.list).toHaveBeenCalledExactlyOnceWith('synthetic-project');
  expect(m.getAuth).not.toHaveBeenCalled();
  expect(m.token).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
  expect(m.jobs).toEqual(untouched);
});

it.each([
  { name: 'offline', arrange: () => vi.stubGlobal('navigator', { onLine: false }), message: 'Connect to the internet to check an approved receipt.' },
  { name: 'missing App Check', arrange: () => { m.appCheck = null; }, message: 'Configure App Check before checking an approved receipt.' },
])('rejects $name without authenticating or reading the server', async ({ arrange, message }) => {
  arrange();
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval')).rejects.toThrow(message);
  expect(m.getAuth).not.toHaveBeenCalled();
  expect(m.token).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
});

it.each([null, { uid: 'synthetic-other-owner' }])('refuses an existing Auth session %s without signing in', async session => {
  m.auth.currentUser = session;
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .rejects.toThrow('Use the existing account that approved this job.');
  expect(m.auth.authStateReady).toHaveBeenCalledOnce();
  expect(m.signup).not.toHaveBeenCalled();
  expect(m.token).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
});

it.each(['listing', 'getAuth', 'Auth ready', 'App Check', 'hash', 'document', 'server read', 'receipt data'])(
  'replaces arbitrary %s errors with a fixed privacy-safe failure', async stage => {
    const failure = Object.assign(new Error('https://synthetic.invalid/?token=synthetic-secret&uid=synthetic-owner'), {
      code: 'synthetic/arbitrary-token-code', config: 'synthetic-config',
    });
    if (stage === 'listing') m.list.mockRejectedValueOnce(failure);
    if (stage === 'getAuth') m.getAuth.mockImplementationOnce(() => { throw failure; });
    if (stage === 'Auth ready') m.auth.authStateReady.mockRejectedValueOnce(failure);
    if (stage === 'App Check') m.token.mockRejectedValueOnce(failure);
    if (stage === 'hash') vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(failure);
    if (stage === 'document') m.doc.mockImplementationOnce(() => { throw failure; });
    if (stage === 'server read') m.read.mockRejectedValueOnce(failure);
    if (stage === 'receipt data') m.read.mockResolvedValueOnce({ exists: () => true, data: () => { throw failure; } });
    const error = await checkApprovedJobReceipt('synthetic-project', 'synthetic-approval').catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Approved receipt could not be checked.');
    expect(error).not.toBe(failure);
    expect(error).not.toHaveProperty('code');
    expect(error).not.toHaveProperty('cause');
    expect(String(error.stack)).not.toContain('synthetic-secret');
    expect(m.signup).not.toHaveBeenCalled();
  },
);

it.each(['listing', 'Auth ready', 'App Check', 'hash', 'server read'].flatMap(stage =>
  ['resolve', 'reject'].map(completion => ({ stage, completion })),
))('bounds $stage with one 15-second deadline and suppresses its late $completion', async ({ stage, completion }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const held = deferred<unknown>();
  const digest = Uint8Array.from(createHash('sha256').update(JSON.stringify(m.jobs[0].payload)).digest()).buffer;
  const hash = vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(digest);
  const exists = vi.fn(() => true); const data = vi.fn(() => receipt());
  const snapshot = { exists, data };
  m.read.mockResolvedValue(snapshot);
  if (stage === 'listing') m.list.mockReturnValueOnce(held.promise);
  if (stage === 'Auth ready') m.auth.authStateReady.mockReturnValueOnce(held.promise);
  if (stage === 'App Check') m.token.mockReturnValueOnce(held.promise);
  if (stage === 'hash') hash.mockReturnValueOnce(held.promise as Promise<ArrayBuffer>);
  if (stage === 'server read') m.read.mockReturnValueOnce(held.promise);
  const untouched = structuredClone(m.jobs);
  const outcome = vi.fn();
  const check = checkApprovedJobReceipt('synthetic-project', 'synthetic-approval')
    .then(value => outcome({ value }), error => outcome({ error: error.message }));
  try {
    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ error: 'Receipt check timed out. The remote outcome is still unknown.' });
  } finally {
    if (completion === 'reject') held.reject(new Error('https://synthetic.invalid/?token=synthetic-late-secret'));
    else held.resolve(stage === 'listing' ? structuredClone(m.jobs) : stage === 'hash' ? digest : stage === 'server read' ? snapshot : undefined);
    await check;
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(outcome).toHaveBeenCalledTimes(1);
  expect(m.getAuth).toHaveBeenCalledTimes(stage === 'listing' ? 0 : 1);
  expect(m.token).toHaveBeenCalledTimes(['listing', 'Auth ready'].includes(stage) ? 0 : 1);
  expect(hash).toHaveBeenCalledTimes(['listing', 'Auth ready', 'App Check'].includes(stage) ? 0 : 1);
  expect(m.read).toHaveBeenCalledTimes(stage === 'server read' ? 1 : 0);
  expect(exists).not.toHaveBeenCalled(); expect(data).not.toHaveBeenCalled();
  expect(m.jobs).toEqual(untouched);
  expect(m.batch).not.toHaveBeenCalled(); expect(m.commit).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled(); expect(m.signup).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['App Check', 'hash', 'server read'])(
  'refuses a session that changes during %s instead of exposing a verified receipt', async stage => {
    const changed = () => { m.auth.currentUser = { uid: 'synthetic-other-owner' }; };
    if (stage === 'App Check') m.token.mockImplementationOnce(async () => { changed(); return {}; });
    if (stage === 'hash') {
      const digest = Uint8Array.from(createHash('sha256').update(JSON.stringify(m.jobs[0].payload)).digest()).buffer;
      vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async () => { changed(); return digest; });
    }
    if (stage === 'server read') m.read.mockImplementationOnce(async () => { changed(); return { exists: () => true, data: () => receipt() }; });
    await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
      .rejects.toThrow('Use the existing account that approved this job.');
    expect(m.read).toHaveBeenCalledTimes(stage === 'server read' ? 1 : 0);
    expect(m.signup).not.toHaveBeenCalled();
  },
);

it('pins the listed immutable snapshot before Auth or token awaits can mutate a returned reference', async () => {
  const saved = structuredClone(m.jobs[0]);
  m.list.mockResolvedValueOnce(m.jobs);
  m.auth.authStateReady.mockImplementationOnce(async () => {
    m.jobs[0].payload.project.title = 'Synthetic later edit';
    m.jobs[0].approvedAt = '2026-11-17T00:00:00.000Z';
  });
  m.read.mockResolvedValueOnce({ exists: () => true, data: () => receipt(saved) });
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .resolves.toEqual({ status: 'verified', jobId: 'synthetic-approval' });
});

it('never follows a changed owner reference into a different Auth account or receipt path', async () => {
  m.list.mockResolvedValueOnce(m.jobs);
  m.token.mockImplementationOnce(async () => {
    m.jobs[0].ownerId = 'synthetic-other-owner'; m.auth.currentUser = { uid: 'synthetic-other-owner' }; return {};
  });
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .rejects.toThrow('Use the existing account that approved this job.');
  expect(m.read).not.toHaveBeenCalled(); expect(m.signup).not.toHaveBeenCalled();
});

it('hashes the exact stored JSON byte order rather than a parsed or canonicalized payload', async () => {
  const payload = m.jobs[0].payload;
  m.jobs[0].payload = { capsules: payload.capsules, project: payload.project, schemaVersion: 1 };
  const hash = vi.spyOn(crypto.subtle, 'digest');
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .resolves.toEqual({ status: 'verified', jobId: 'synthetic-approval' });
  expect(hash).toHaveBeenCalledExactlyOnceWith('SHA-256', new TextEncoder().encode(JSON.stringify(m.jobs[0].payload)));
  expect(m.doc).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'users', 'synthetic-owner', 'approvals', 'synthetic-approval');
});

it.each(['ownerId', 'payloadHash', 'projectId', 'approvedAt'].flatMap(field =>
  [undefined, 1].map(value => ({ field, value })),
))('rejects a missing or wrong-type receipt $field ($value) without coercion', async ({ field, value }) => {
  m.read.mockResolvedValueOnce({ exists: () => true, data: () => ({ ...receipt(), [field]: value }) });
  await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
    .rejects.toThrow('Cloud receipt does not match the approved job.');
});

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
it.each((['pending', 'failed', 'synced'] as const).flatMap(status =>
  ['verified', 'missing', 'mismatch'].map(result => ({ status, result })),
))('never writes or mutates a frozen $status approval on $result', async ({ status, result }) => {
  m.jobs[0].status = status;
  const untouched = structuredClone(m.jobs);
  m.list.mockResolvedValueOnce(freeze(m.jobs));
  if (result === 'missing') m.read.mockResolvedValueOnce({ exists: () => false, data: vi.fn() });
  if (result === 'mismatch') m.read.mockResolvedValueOnce({ exists: () => true, data: () => ({ ...receipt(), ownerId: 'synthetic-other-owner' }) });
  const check = checkApprovedJobReceipt('synthetic-project', 'synthetic-approval');
  if (result === 'mismatch') await expect(check).rejects.toThrow('Cloud receipt does not match the approved job.');
  else await expect(check).resolves.toEqual({ status: result, jobId: 'synthetic-approval' });
  expect(m.jobs).toEqual(untouched);
  expect(m.update).not.toHaveBeenCalled(); expect(m.batch).not.toHaveBeenCalled();
  expect(m.set).not.toHaveBeenCalled(); expect(m.commit).not.toHaveBeenCalled(); expect(m.signup).not.toHaveBeenCalled();
});

it('waits for supported existing Auth restoration before requiring its owner, without signup', async () => {
  const ready = deferred<void>(); const started = deferred<void>();
  m.auth.currentUser = null;
  m.auth.authStateReady.mockImplementationOnce(() => { started.resolve(); return ready.promise; });
  const check = checkApprovedJobReceipt('synthetic-project', 'synthetic-approval');
  try {
    await started.promise;
    expect(m.token).not.toHaveBeenCalled(); expect(m.read).not.toHaveBeenCalled(); expect(m.signup).not.toHaveBeenCalled();
  } finally {
    m.auth.currentUser = { uid: 'synthetic-owner' }; ready.resolve();
    await check;
  }
  await expect(check).resolves.toEqual({ status: 'verified', jobId: 'synthetic-approval' });
});

it('shares one total 15-second budget across listing, Auth, token and hashing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const listing = deferred<SyncJob[]>(); const auth = deferred<void>();
  const token = deferred<object>(); const hashing = deferred<ArrayBuffer>();
  const digest = Uint8Array.from(createHash('sha256').update(JSON.stringify(m.jobs[0].payload)).digest()).buffer;
  m.list.mockReturnValueOnce(listing.promise); m.auth.authStateReady.mockReturnValueOnce(auth.promise);
  m.token.mockReturnValueOnce(token.promise); vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(hashing.promise);
  const outcome = vi.fn();
  const check = checkApprovedJobReceipt('synthetic-project', 'synthetic-approval')
    .then(value => outcome({ value }), error => outcome({ error: error.message }));
  try {
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000); listing.resolve(structuredClone(m.jobs)); await vi.advanceTimersByTimeAsync(0);
    expect(m.auth.authStateReady).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000); auth.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(m.token).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000); token.resolve({}); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_999); expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ error: 'Receipt check timed out. The remote outcome is still unknown.' });
  } finally {
    listing.resolve(structuredClone(m.jobs)); auth.resolve(); token.resolve({}); hashing.resolve(digest);
    await check; await vi.advanceTimersByTimeAsync(0);
  }
  expect(m.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['listing', 'Auth ready', 'App Check', 'hash', 'document', 'server read', 'receipt exists', 'receipt data'])(
  'guards the monotonic deadline at %s even before a delayed timer can fire', async stage => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const expire = () => { clock.mockReturnValue(15_000); };
    const digest = Uint8Array.from(createHash('sha256').update(JSON.stringify(m.jobs[0].payload)).digest()).buffer;
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(digest);
    if (stage === 'listing') m.list.mockImplementationOnce(async () => { expire(); return structuredClone(m.jobs); });
    if (stage === 'Auth ready') m.auth.authStateReady.mockImplementationOnce(async () => { expire(); });
    if (stage === 'App Check') m.token.mockImplementationOnce(async () => { expire(); return {}; });
    if (stage === 'hash') vi.mocked(crypto.subtle.digest).mockImplementationOnce(async () => { expire(); return digest; });
    if (stage === 'document') m.doc.mockImplementationOnce(() => { expire(); return { path: 'users/synthetic-owner/approvals/synthetic-approval' }; });
    if (stage === 'server read') m.read.mockImplementationOnce(async () => { expire(); return { exists: vi.fn(), data: vi.fn() }; });
    if (stage === 'receipt exists') m.read.mockResolvedValueOnce({ exists: () => { expire(); return false; }, data: vi.fn() });
    if (stage === 'receipt data') m.read.mockResolvedValueOnce({ exists: () => true, data: () => { expire(); return receipt(); } });
    await expect(checkApprovedJobReceipt('synthetic-project', 'synthetic-approval'))
      .rejects.toThrow('Receipt check timed out. The remote outcome is still unknown.');
    expect(m.read).toHaveBeenCalledTimes(['server read', 'receipt exists', 'receipt data'].includes(stage) ? 1 : 0);
  },
);

it.each(['verified', 'missing', 'error', 'timeout'])(
  'leaves a real active sync promise and its writes untouched on diagnostic %s', async result => {
    if (result === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const commit = deferred<void>(); const started = deferred<void>(); const listing = deferred<SyncJob[]>();
    m.commit.mockImplementationOnce(() => { started.resolve(); return commit.promise; });
    const active = syncApprovedJobs('synthetic-project');
    await started.promise;
    const writes = { batches: m.batch.mock.calls.length, sets: m.set.mock.calls.length, commits: m.commit.mock.calls.length, updates: m.update.mock.calls.length };
    const untouched = structuredClone(m.jobs);
    if (result === 'missing') m.read.mockResolvedValueOnce({ exists: () => false, data: vi.fn() });
    if (result === 'error') m.token.mockRejectedValueOnce(new Error('synthetic-private-transport-error'));
    if (result === 'timeout') m.list.mockReturnValueOnce(listing.promise);
    const outcome = vi.fn();
    const check = checkApprovedJobReceipt('synthetic-project', 'synthetic-approval')
      .then(value => outcome({ value }), error => outcome({ error: error.message }));
    try {
      if (result === 'timeout') await vi.advanceTimersByTimeAsync(15_000);
      await check;
      if (result === 'verified' || result === 'missing') expect(outcome).toHaveBeenCalledExactlyOnceWith({ value: { status: result, jobId: 'synthetic-approval' } });
      else expect(outcome).toHaveBeenCalledExactlyOnceWith({ error: result === 'timeout' ? 'Receipt check timed out. The remote outcome is still unknown.' : 'Approved receipt could not be checked.' });
      expect(syncApprovedJobs('synthetic-project')).toBe(active);
      await expect(syncApprovedJobs('synthetic-foreign')).rejects.toThrow('A synchronization for a different project scope is already in progress.');
      expect(syncApprovedJobs('synthetic-project')).toBe(active);
      expect({ batches: m.batch.mock.calls.length, sets: m.set.mock.calls.length, commits: m.commit.mock.calls.length, updates: m.update.mock.calls.length }).toEqual(writes);
      expect(m.jobs).toEqual(untouched); expect(m.signup).not.toHaveBeenCalled();
    } finally {
      listing.resolve(structuredClone(m.jobs));
      if (result === 'timeout') await vi.advanceTimersByTimeAsync(0);
      commit.resolve(); await active; await check;
    }
    await expect(active).resolves.toEqual({ synced: 1, failed: 0 });
  },
);
