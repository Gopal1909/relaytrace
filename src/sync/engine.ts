import type { SyncJob } from '../domain/types';
import { validateSharingPayload } from '../domain/sharing-validation';
type Patch = Partial<Pick<SyncJob, 'status' | 'attempts' | 'ownerId' | 'error'>>;
export interface SyncDependencies {
  list(): Promise<SyncJob[]>;
  mark(id: string, patch: Patch): Promise<unknown>;
  authenticate(): Promise<string>;
  upload(owner: string, job: SyncJob): Promise<void>;
}
export async function processApprovedJobs(deps: SyncDependencies): Promise<{ synced: number; failed: number }> {
  const jobs = (await deps.list()).filter(job => job.status !== 'synced');
  if (!jobs.length) return { synced: 0, failed: 0 };
  const owner = await deps.authenticate();
  let synced = 0; let failed = 0;
  for (const job of jobs) {
    try {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(job.id) || !job.approvedAt || Number.isNaN(Date.parse(job.approvedAt))) throw new Error('Invalid approval');
      validateSharingPayload(job.payload);
      if (job.projectId !== job.payload.project.id || (job.ownerId && job.ownerId !== owner)) throw new Error('Approval account or project mismatch');
      const patch = { ownerId: owner, attempts: job.attempts + 1 };
      await deps.mark(job.id, patch); // Persist identity binding BEFORE any content upload.
      await deps.upload(owner, { ...job, ...patch });
      await deps.mark(job.id, { status: 'synced', error: '' }); synced++;
    } catch {
      await deps.mark(job.id, { status: 'failed', error: 'Transfer not completed. Check account, connectivity and Firebase configuration; then explicitly retry.' });
      failed++;
    }
  }
  return { synced, failed };
}
