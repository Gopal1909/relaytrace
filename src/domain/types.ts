import type { CapsuleDraft } from '../ai/capsule';

export interface Project {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export interface Capsule {
  id: string;
  projectId: string;
  parentId: string | null;
  createdAt: string;
  confirmedAt: string;
  originalNote: string;
  fields: CapsuleDraft;
  source: 'manual' | 'on_device';
  photo?: Blob;
  photoName?: string;
}
export interface SaveCapsuleInput {
  projectId: string;
  originalNote: string;
  fields: CapsuleDraft;
  source: 'manual' | 'on_device';
  confirmed: boolean;
  photo?: Blob;
  photoName?: string;
}
export interface SharingPayload {
  schemaVersion: 1;
  project: { id: string; title: string };
  capsules: Array<Omit<Capsule, 'photo' | 'photoName'>>;
}
export interface SyncJob {
  id: string;
  projectId: string;
  payload: SharingPayload;
  approvedAt: string;
  status: 'pending' | 'failed' | 'synced';
  attempts: number;
  ownerId?: string;
  error?: string;
}
