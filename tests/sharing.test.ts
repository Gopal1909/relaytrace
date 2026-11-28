import { expect, it } from 'vitest';
import type { Capsule, Project } from '../src/domain/types';
import { makeSharingPreview } from '../src/domain/sharing';

it('whitelists the exact sharing schema and deeply isolates approved text from private photos', () => {
  const project: Project = { id: 'synthetic-project', title: 'Bench', description: 'Private description', createdAt: 'now', updatedAt: 'now' };
  const capsule: Capsule = {
    id: 'synthetic-capsule', projectId: project.id, parentId: null, createdAt: 'now', confirmedAt: 'now',
    originalNote: 'Synthetic note', source: 'manual', photo: new Blob(['private']), photoName: 'private-name.png',
    fields: { observation: ['Synthetic observation'], attempted: [], changed: [], result: [], unresolved: [], next_check: [] },
  };
  const projectWithExtras = { ...project, secret: 'no' };
  const capsuleWithExtras = { ...capsule, secret: 'no' };
  const preview = makeSharingPreview(projectWithExtras, [capsuleWithExtras]);
  expect(preview).toEqual({ schemaVersion: 1, project: { id: project.id, title: project.title }, capsules: [{
    id: capsule.id, projectId: project.id, parentId: null, createdAt: 'now', confirmedAt: 'now', originalNote: 'Synthetic note', source: 'manual', fields: capsule.fields,
  }] });
  expect(Object.keys(preview.capsules[0]).sort()).toEqual(['id', 'projectId', 'parentId', 'createdAt', 'confirmedAt', 'originalNote', 'source', 'fields'].sort());
  project.title = 'changed'; capsule.fields.observation.push('changed');
  expect(preview.project.title).toBe('Bench');
  expect(preview.capsules[0].fields.observation).toEqual(['Synthetic observation']);
  preview.capsules[0].fields.next_check.push('preview edit');
  expect(capsule.fields.next_check).toEqual([]);
  expect(JSON.stringify(preview)).not.toMatch(/private|secret|photo/i);
});
