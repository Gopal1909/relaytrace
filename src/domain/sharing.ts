import type { Capsule, Project, SharingPayload } from './types';

/** Explicit export whitelist: local photo data and filenames never leave this boundary. */
export function makeSharingPreview(project: Project, capsules: Capsule[]): SharingPayload {
  return {
    schemaVersion: 1,
    project: { id: project.id, title: project.title },
    capsules: capsules.map(capsule => ({
      id: capsule.id, projectId: capsule.projectId, parentId: capsule.parentId,
      createdAt: capsule.createdAt, confirmedAt: capsule.confirmedAt,
      originalNote: capsule.originalNote, source: capsule.source,
      fields: {
        observation: [...capsule.fields.observation], attempted: [...capsule.fields.attempted],
        changed: [...capsule.fields.changed], result: [...capsule.fields.result],
        unresolved: [...capsule.fields.unresolved], next_check: [...capsule.fields.next_check],
      },
    })),
  };
}
