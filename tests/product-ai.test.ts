import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ construct: vi.fn(), initialize: vi.fn(), stream: vi.fn(), cloud: vi.fn() }));
vi.mock('../src/lib/firebase', () => ({ ai: {} }));
vi.mock('firebase/ai', async original => ({ ...await original<typeof import('firebase/ai')>(), getGenerativeModel: mocks.construct }));
import { InferenceMode } from 'firebase/ai';
import { extractCapsule, synthesizeHandoff, prepareLocalModel, releaseLocalModel, cancelLocalExtraction, releaseIdleLocalModel, createLocalInferenceRunner } from '../src/ai/product-ai';
const fields = { observation: ['Synthetic observation'], attempted: [], changed: [], result: [], unresolved: [], next_check: [] };
const payload = { schemaVersion: 1 as const, project: { id: 'p1', title: 'Synthetic bench' }, capsules: [{ id: 'c1', projectId: 'p1', parentId: null, createdAt: '2026-11-16T00:00:00.000Z', confirmedAt: '2026-11-16T00:00:00.000Z', originalNote: 'Synthetic note', source: 'manual' as const, fields }] };
beforeEach(() => {
  releaseLocalModel(); vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.stream.mockResolvedValue({ stream: (async function* () {})(), response: Promise.resolve({ inferenceSource: 'on_device', text: () => JSON.stringify(fields) }) });
  mocks.cloud.mockResolvedValue({ response: { inferenceSource: 'in_cloud', text: () => 'Synthetic handoff fixture' } });
  mocks.construct.mockReturnValue({ initializeDeviceModel: mocks.initialize, generateContentStream: mocks.stream, generateContent: mocks.cloud });
});
afterEach(() => { releaseLocalModel(); vi.useRealTimers(); vi.unstubAllGlobals(); });
// SDK adapter fixtures: none of these assertions is evidence of live inference.
it.each(['extraction', 'warmup'] as const)('caps product %s generation at 20 seconds, not minutes', async operation => {
  vi.useFakeTimers(); const metrics = vi.fn();
  mocks.stream.mockImplementation(() => new Promise(() => {}));
  const pending = operation === 'extraction' ? extractCapsule({ note: 'Synthetic note', onMetrics: metrics }) : prepareLocalModel({ onMetrics: metrics });
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(20001);
  expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ status: 'timed_out', interruptedStage: 'generating' }));
  await expect(pending).rejects.toThrow(/Timed out.*generating/);
  expect(mocks.cloud).not.toHaveBeenCalled();
});
it('exposes the same local-only adapter for controlled fresh versus retained model comparisons', async () => {
  const fresh = createLocalInferenceRunner(false);
  await fresh.run({ prompt: 'Synthetic first', structured: true });
  await fresh.run({ prompt: 'Synthetic second', structured: true });
  expect(mocks.construct).toHaveBeenCalledTimes(2);
  expect(mocks.construct.mock.calls[0][1].onDeviceParams.createOptions.signal.aborted).toBe(true);
  const shared = createLocalInferenceRunner(true);
  await shared.run({ prompt: 'Synthetic bootstrap', structured: true });
  await shared.run({ prompt: 'Synthetic reused', structured: true });
  expect(mocks.construct).toHaveBeenCalledTimes(3);
  for (const call of mocks.construct.mock.calls) expect(call[1].mode).toBe(InferenceMode.ONLY_ON_DEVICE);
  expect(mocks.cloud).not.toHaveBeenCalled(); shared.release();
});
it('idle release rejects active work without aborting its SDK lifetime', async () => {
  let resolve!: () => void;
  mocks.initialize.mockImplementation(() => new Promise<void>(yes => { resolve = yes; }));
  const pending = prepareLocalModel();
  const signal = mocks.construct.mock.calls[0][1].onDeviceParams.createOptions.signal;
  try {
    expect(() => releaseIdleLocalModel()).toThrow(/already running/i);
    expect(signal.aborted).toBe(false);
    await expect(prepareLocalModel()).rejects.toThrow(/already running/i);
    resolve();
    await expect(pending).resolves.toEqual({ source: 'on_device' });
    expect(signal.aborted).toBe(false);
  } finally { releaseLocalModel(); await pending.catch(() => {}); }
});
it('idle release aborts the retained idle model and allows a fresh request', async () => {
  await prepareLocalModel();
  const signal = mocks.construct.mock.calls[0][1].onDeviceParams.createOptions.signal;
  expect(signal.aborted).toBe(false);
  releaseIdleLocalModel();
  expect(signal.aborted).toBe(true);
  await prepareLocalModel();
  expect(mocks.construct).toHaveBeenCalledTimes(2);
  expect(mocks.cloud).not.toHaveBeenCalled();
});
it('bounds synthetic warmup generation and never falls back to a cloud call', async () => {
  vi.useFakeTimers(); const metrics = vi.fn();
  mocks.stream.mockImplementation(() => new Promise(() => {}));
  const pending = prepareLocalModel({ onMetrics: metrics });
  const rejected = expect(pending).rejects.toThrow(/Timed out.*generating/);
  await vi.advanceTimersByTimeAsync(30001); await rejected;
  expect(mocks.construct.mock.calls[0][1].onDeviceParams.createOptions.signal.aborted).toBe(true);
  expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ operation: 'warmup', status: 'timed_out', interruptedStage: 'generating' }));
  expect(mocks.stream).toHaveBeenCalledOnce(); expect(mocks.cloud).not.toHaveBeenCalled();
});
it('times only the first nonempty text chunk, returning the actual final response after both promises finish', async () => {
  vi.useFakeTimers(); const metrics = vi.fn();
  mocks.stream.mockResolvedValue({ stream: (async function* () {
    await new Promise(r => setTimeout(r, 7)); yield { inferenceSource: 'on_device', text: () => '' };
    await new Promise(r => setTimeout(r, 4));
    yield { inferenceSource: 'on_device', text: () => '{' };
    await new Promise(r => setTimeout(r, 2));
  })(), response: Promise.resolve({ inferenceSource: 'on_device', text: () => JSON.stringify(fields) }) });
  let finished = false;
  const pending = extractCapsule({ note: 'private', onMetrics: metrics }).then(result => { finished = true; return result; });
  await vi.advanceTimersByTimeAsync(7); expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(6); await expect(pending).resolves.toEqual({ fields, source: 'on_device' });
  expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ firstChunkLatencyMs: 11, generationMs: 13 }));
  const metadata = JSON.stringify(metrics.mock.calls); expect(metadata).not.toMatch(/private|Synthetic observation/);
});
it('requires actual local final provenance for warmup too', async () => {
  mocks.stream.mockResolvedValue({ stream: (async function* () { yield { inferenceSource: 'on_device', text: () => '{' }; })(), response: Promise.resolve({ inferenceSource: 'in_cloud', text: () => JSON.stringify(fields) }) });
  await expect(prepareLocalModel()).rejects.toThrow(/on-device|cloud/);
  expect(mocks.construct.mock.calls[0][1].onDeviceParams.createOptions.signal.aborted).toBe(true);
  expect(mocks.cloud).not.toHaveBeenCalled();
});
it('registers pagehide release without automatically warming at import', async () => {
  vi.resetModules(); const window = new EventTarget(); vi.stubGlobal('window', window);
  const isolated = await import('../src/ai/product-ai');
  expect(mocks.construct).not.toHaveBeenCalled();
  await isolated.prepareLocalModel(); const signal = mocks.construct.mock.calls[0][1].onDeviceParams.createOptions.signal;
  window.dispatchEvent(new Event('pagehide')); expect(signal.aborted).toBe(true); isolated.releaseLocalModel();
});
it('warms through one synthetic schema stream then reuses the shared model for extraction', async () => {
  const metrics = vi.fn();
  await expect(prepareLocalModel({ onMetrics: metrics })).resolves.toEqual({ source: 'on_device' });
  expect(mocks.stream).toHaveBeenCalledOnce();
  expect(mocks.stream.mock.calls[0][0]).toMatch(/synthetic/i);
  expect(mocks.stream.mock.calls[0][0].length).toBeLessThan(600);
  expect(mocks.construct.mock.calls[0][1].onDeviceParams.promptOptions.responseConstraint).toBeDefined();
  await extractCapsule({ note: 'private note', onMetrics: metrics });
  expect(mocks.construct).toHaveBeenCalledOnce(); expect(mocks.initialize).toHaveBeenCalledOnce();
  expect(metrics.mock.calls[0][0]).toMatchObject({ operation: 'warmup', status: 'passed', modelReused: false });
  expect(metrics.mock.calls[1][0]).toMatchObject({ operation: 'extraction', status: 'passed', modelReused: true });
  expect(mocks.cloud).not.toHaveBeenCalled(); releaseLocalModel();
});
it('cancels stalled photo preprocessing, shares the busy lock with warmup, and recovers without using the late image', async () => {
  let resolve!: (buffer: ArrayBuffer) => void;
  const photo = new Blob(['private'], { type: 'image/png' });
  vi.spyOn(photo, 'arrayBuffer').mockImplementation(() => new Promise(r => { resolve = r; }));
  const metrics = vi.fn();
  const pending = extractCapsule({ note: 'private', photo, onMetrics: metrics });
  const rejected = expect(pending).rejects.toThrow(/cancel/i);
  await expect(prepareLocalModel()).rejects.toThrow(/already running/);
  cancelLocalExtraction(); await rejected;
  expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled', interruptedStage: 'preprocessing' }));
  await expect(extractCapsule({ note: 'new' })).resolves.toMatchObject({ source: 'on_device' });
  resolve(new ArrayBuffer(4)); await Promise.resolve();
  expect(mocks.stream).toHaveBeenCalledOnce(); expect(mocks.cloud).not.toHaveBeenCalled();
});
it('does not construct or call a cloud model without explicit consent', async () => {
  await expect(synthesizeHandoff(payload, false)).rejects.toThrow(/consent|approval/i);
  expect(mocks.construct).not.toHaveBeenCalled();
});
it('consumes the official SDK stream and validates actual final local provenance', async () => {
  await expect(extractCapsule({ note: 'Synthetic note' })).resolves.toEqual({ fields, source: 'on_device' });
  expect(mocks.construct.mock.calls[0][1].mode).toBe(InferenceMode.ONLY_ON_DEVICE);
  expect(mocks.stream).toHaveBeenCalledOnce(); expect(mocks.cloud).not.toHaveBeenCalled();
});
it('rejects cloud output from the local extraction path', async () => {
  mocks.stream.mockResolvedValue({ stream: (async function* () {})(), response: Promise.resolve({ inferenceSource: 'in_cloud', text: () => JSON.stringify(fields) }) });
  await expect(extractCapsule({ note: 'Synthetic note' })).rejects.toThrow(/on-device|cloud/);
});
it('rejects malformed local JSON rather than filling fields', async () => {
  mocks.stream.mockResolvedValue({ stream: (async function* () {})(), response: Promise.resolve({ inferenceSource: 'on_device', text: () => '{}' }) });
  await expect(extractCapsule({ note: 'Synthetic note' })).rejects.toThrow(/six/);
});
it('requires a nonempty input and rejects unsupported images before model creation', async () => {
  await expect(extractCapsule({ note: ' ' })).rejects.toThrow();
  await expect(extractCapsule({ note: 'Synthetic note', photo: new Blob(['x'], { type: 'image/svg+xml' }) })).rejects.toThrow(/JPEG|PNG/);
  expect(mocks.construct).not.toHaveBeenCalled();
});
it('uses cloud-only routing for explicitly approved text history', async () => {
  await expect(synthesizeHandoff(payload, true)).resolves.toEqual({ text: 'Synthetic handoff fixture', source: 'in_cloud' });
  expect(mocks.construct.mock.calls[0][1].mode).toBe(InferenceMode.ONLY_IN_CLOUD);
});
it('refuses photos and unknown properties in cloud payloads even with consent', async () => {
  await expect(synthesizeHandoff({ ...payload, photo: 'private image' } as never, true)).rejects.toThrow();
  expect(mocks.construct).not.toHaveBeenCalled();
});
