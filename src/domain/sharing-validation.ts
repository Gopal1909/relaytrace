import { z } from 'zod';
import { capsuleFields } from '../ai/capsule';
import type { SharingPayload } from './types';
const segment = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const fields = z.object(Object.fromEntries(capsuleFields.map(key => [key, z.array(z.string().max(10000)).max(100)]))).strict();
const schema = z.object({
  schemaVersion: z.literal(1), project: z.object({ id: segment, title: z.string().min(1).max(120) }).strict(),
  capsules: z.array(z.object({ id: segment, projectId: segment, parentId: segment.nullable(),
    createdAt: z.string().datetime(), confirmedAt: z.string().datetime(), originalNote: z.string().max(20000),
    fields, source: z.enum(['manual', 'on_device']),
  }).strict()).min(1).max(200),
}).strict();
export function validateSharingPayload(payload: unknown): asserts payload is SharingPayload {
  const value = schema.parse(payload);
  if (value.capsules.some(c => c.projectId !== value.project.id)) throw new Error('History must belong to the selected project.');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 500000) throw new Error('Select a smaller history for cloud processing.');
}
