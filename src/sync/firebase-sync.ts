import { getAuth, signInAnonymously } from 'firebase/auth';
import { getToken } from 'firebase/app-check';
import { doc, getDocFromServer, getFirestore, writeBatch } from 'firebase/firestore';
import { firebaseApp, appCheck } from '../lib/firebase';
import { store } from '../storage/store';
import { processApprovedJobs } from './engine';
import { validateSharingPayload } from '../domain/sharing-validation';
let current: { projectId: string | undefined; promise: Promise<{ synced: number; failed: number }> } | null = null;
export function syncApprovedJobs(projectId?: string): Promise<{ synced: number; failed: number }> {
  if (current) {
    if (current.projectId !== projectId) return Promise.reject(new Error('A synchronization for a different project scope is already in progress.'));
    return current.promise;
  }
  const promise = processApprovedJobs({
    list: () => store.listJobs(projectId),
    mark: (id, patch) => store.updateJob(id, patch),
    authenticate: async () => {
      if (!navigator.onLine) throw new Error('Connect to the internet to send approved records.');
      if (!appCheck) throw new Error('Configure App Check before cloud synchronization.');
      await getToken(appCheck, false);
      const auth = getAuth(firebaseApp);
      return (auth.currentUser ?? (await signInAnonymously(auth)).user).uid;
    },
    upload: async (owner, job) => {
      const db = getFirestore(firebaseApp);
      const encoded = new TextEncoder().encode(JSON.stringify(job.payload));
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const payloadHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const batch = writeBatch(db);
      const project = doc(db, 'users', owner, 'projects', job.projectId);
      batch.set(project, { ownerId: owner, id: job.projectId, title: job.payload.project.title });
      for (const capsule of job.payload.capsules) {
        batch.set(doc(project, 'capsules', capsule.id), { ...capsule, ownerId: owner, approvedAt: job.approvedAt });
      }
      const receipt = doc(db, 'users', owner, 'approvals', job.id);
      batch.set(receipt, { ownerId: owner, projectId: job.projectId, approvedAt: job.approvedAt, payloadHash });
      await batch.commit();
      const readback = await getDocFromServer(receipt);
      if (!readback.exists() || readback.data().payloadHash !== payloadHash || readback.data().ownerId !== owner) {
        throw new Error('Cloud receipt could not be verified.');
      }
    },
  }).finally(() => { current = null; });
  current = { projectId, promise };
  return promise;
}

// Only errors constructed here may retain their message; SDK/storage errors are never surfaced.
class ReceiptCheckError extends Error {}

export async function checkApprovedJobReceipt(projectId: string, jobId: string): Promise<{ status: 'verified' | 'missing'; jobId: string }> {
  const deadline = performance.now() + 15_000;
  let inactive = false;
  const timeoutMessage = 'Receipt check timed out. The remote outcome is still unknown.';
  const assertActive = () => {
    if (inactive || performance.now() >= deadline) throw new ReceiptCheckError(timeoutMessage);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { inactive = true; reject(new ReceiptCheckError(timeoutMessage)); }, 15_000);
  });
  const inspect = async (): Promise<{ status: 'verified' | 'missing'; jobId: string }> => {
    const segment = /^[A-Za-z0-9_-]{1,100}$/;
    if (typeof projectId !== 'string' || typeof jobId !== 'string' || !segment.test(projectId) || !segment.test(jobId)) {
      throw new ReceiptCheckError('Invalid approval identifiers.');
    }
    assertActive();
    const jobs = await store.listJobs(projectId);
    assertActive();
    const saved = jobs.find(candidate => candidate.id === jobId);
    // Pin the persisted approval, including JSON key order and owner, before any Auth/SDK await.
    const job = saved ? structuredClone(saved) : undefined;
    if (!job || job.projectId !== projectId || typeof job.approvedAt !== 'string' ||
      !job.approvedAt || Number.isNaN(Date.parse(job.approvedAt)) ||
      typeof job.ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.ownerId)) {
      throw new ReceiptCheckError('Saved approval is unavailable or invalid.');
    }
    try {
      validateSharingPayload(job.payload);
    } catch {
      throw new ReceiptCheckError('Saved approval is unavailable or invalid.');
    }
    if (job.payload.project.id !== projectId) throw new ReceiptCheckError('Saved approval is unavailable or invalid.');
    if (!navigator.onLine) throw new ReceiptCheckError('Connect to the internet to check an approved receipt.');
    if (!appCheck) throw new ReceiptCheckError('Configure App Check before checking an approved receipt.');
    assertActive();
    const auth = getAuth(firebaseApp);
    const assertOwner = () => {
      if (auth.currentUser?.uid !== job.ownerId) throw new ReceiptCheckError('Use the existing account that approved this job.');
    };
    await auth.authStateReady();
    assertActive();
    assertOwner();
    await getToken(appCheck, false);
    assertActive();
    assertOwner();
    const encoded = new TextEncoder().encode(JSON.stringify(job.payload));
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    assertActive();
    assertOwner();
    const payloadHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const reference = doc(getFirestore(firebaseApp), 'users', job.ownerId, 'approvals', jobId);
    assertActive();
    const readback = await getDocFromServer(reference);
    assertActive();
    assertOwner();
    // A missing receipt cannot rule out an already dispatched, eventually completed upload.
    if (!readback.exists()) return { status: 'missing', jobId };
    const receipt = readback.data();
    if (receipt.ownerId !== job.ownerId || receipt.payloadHash !== payloadHash ||
      receipt.projectId !== projectId || receipt.approvedAt !== job.approvedAt) {
      throw new ReceiptCheckError('Cloud receipt does not match the approved job.');
    }
    return { status: 'verified', jobId };
  };
  try {
    const result = await Promise.race([inspect(), timeout]);
    assertActive();
    return result;
  } catch (error) {
    assertActive();
    if (error instanceof ReceiptCheckError) throw error;
    throw new Error('Approved receipt could not be checked.');
  } finally {
    inactive = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
