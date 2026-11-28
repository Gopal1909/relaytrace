import { afterEach, expect, it, vi } from 'vitest';
import { LocalRequestRunner } from '../src/ai/local-request';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('expires an idle cache by elapsed time even when the browser delays its timer', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); const signals: AbortSignal[] = [];
  const create = vi.fn((signal: AbortSignal) => { signals.push(signal); return { initializeDeviceModel: async () => {}, generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }) }; });
  const runner = new LocalRequestRunner(create, { retainModel: true, idleTtlMs: 50 });
  await runner.run({ prompt: 'first' }); now = 51;
  await runner.run({ prompt: 'after idle deadline' });
  expect(create).toHaveBeenCalledTimes(2); expect(signals[0].aborted).toBe(true); runner.release();
});
it('rejects a completion past the wall-clock deadline even before a delayed timer callback runs', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  let signal!: AbortSignal; const metrics = vi.fn();
  const runner = new LocalRequestRunner(s => { signal = s; return {
    initializeDeviceModel: async () => { now = 11; },
    generateContent: vi.fn(async () => ({ response: { inferenceSource: 'on_device', text: () => 'too late' } })),
  }; }, { retainModel: true });
  await expect(runner.run({ prompt: 'private', initializationTimeoutMs: 10, onMetrics: metrics })).rejects.toThrow(/Timed out.*initializing/);
  expect(signal.aborted).toBe(true); expect(runner.isRunning).toBe(false);
  expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ status: 'timed_out', interruptedStage: 'initializing' }));
});
// Deterministic adapter fixtures only: these tests do not prove browser inference.
it.each(['initializing', 'generating'] as const)('times out %s, aborts the lifetime, and ignores late completion after recovery', async stage => {
  vi.useFakeTimers(); let finish!: () => void; const signals: AbortSignal[] = []; const metrics = vi.fn();
  const pendingStage = new Promise<void>(resolve => { finish = resolve; });
  const response = { response: { inferenceSource: 'on_device', text: () => 'ok' } };
  const create = vi.fn((signal: AbortSignal) => { signals.push(signal); return {
    initializeDeviceModel: () => stage === 'initializing' ? pendingStage : Promise.resolve(),
    generateContent: async () => { if (stage === 'generating') await pendingStage; return response; },
  }; });
  const runner = new LocalRequestRunner(create, { retainModel: true });
  const pending = runner.run({ prompt: 'private', initializationTimeoutMs: 10, generationTimeoutMs: 10, onMetrics: metrics });
  const rejected = expect(pending).rejects.toThrow(/Timed out/);
  await vi.advanceTimersByTimeAsync(11); await rejected;
  expect(signals[0].aborted).toBe(true); expect(runner.isRunning).toBe(false);
  expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ status: 'timed_out', interruptedStage: stage }));
  create.mockImplementation(signal => { signals.push(signal); return { initializeDeviceModel: async () => {}, generateContent: async () => response }; });
  await runner.run({ prompt: 'recovered' }); finish(); await Promise.resolve();
  await runner.run({ prompt: 'still warm' }); expect(create).toHaveBeenCalledTimes(2);
  expect(signals[1].aborted).toBe(false); expect(metrics).toHaveBeenCalledOnce(); runner.release();
});
it('keeps default diagnostic runners single-use and evicts failed retained results', async () => {
  const signals: AbortSignal[] = []; const generate = vi.fn(async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }));
  const create = vi.fn((signal: AbortSignal) => { signals.push(signal); return { initializeDeviceModel: async () => {}, generateContent: generate }; });
  const diagnostic = new LocalRequestRunner(create);
  await diagnostic.run({ prompt: 'one' }); await diagnostic.run({ prompt: 'two' });
  expect(create).toHaveBeenCalledTimes(2); expect(signals.every(s => s.aborted)).toBe(true);
  const retained = new LocalRequestRunner(create, { retainModel: true });
  await expect(retained.run({ prompt: 'invalid', format: () => { throw new Error('invalid'); } })).rejects.toThrow('invalid');
  expect(signals[2].aborted).toBe(true); await retained.run({ prompt: 'recovery' }); expect(create).toHaveBeenCalledTimes(4); retained.release();
});
it('suppresses obsolete progress and chunk observers even when a retained lifetime is reused', async () => {
  const updates = vi.fn(); let oldProgress: ((n: number) => void) | undefined; let oldChunk: (() => void) | undefined;
  const runner = new LocalRequestRunner(() => ({
    initializeDeviceModel: async cb => { oldProgress = cb; },
    setFirstChunkObserver: listener => { if (listener) oldChunk = listener; },
    generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }),
  }), { retainModel: true });
  await runner.run({ prompt: 'first', onProgress: updates });
  const staleChunk = oldChunk;
  const second = runner.run({ prompt: 'second' });
  oldProgress?.(99); staleChunk?.(); await second;
  expect(updates).not.toHaveBeenCalled(); runner.release();
});
it('cancelling an idle retained model releases its lifetime', async () => {
  let signal!: AbortSignal;
  const runner = new LocalRequestRunner(s => { signal = s; return { initializeDeviceModel: async () => {}, generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }) }; }, { retainModel: true });
  await runner.run({ prompt: 'private' }); runner.cancel(); expect(signal.aborted).toBe(true);
});
it('never accepts a result when the validating callback cancels the operation', async () => {
  const runner = new LocalRequestRunner(() => ({ initializeDeviceModel: async () => {}, generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }) }), { retainModel: true });
  await expect(runner.run({ prompt: 'private', onStage: stage => { if (stage === 'validating') runner.cancel(); } })).rejects.toThrow(/cancel/);
});
it.each(['initializing', 'generating'] as const)('cancel immediately unlocks a never-resolving %s and ignores late callbacks', async stage => {
  let progress: ((n: number) => void) | undefined;
  const updates = vi.fn();
  const signals: AbortSignal[] = [];
  const create = vi.fn((signal: AbortSignal) => { signals.push(signal); return {
    initializeDeviceModel: (cb?: (n: number) => void) => { progress = cb; return stage === 'initializing' ? new Promise<void>(() => {}) : Promise.resolve(); },
    generateContent: () => new Promise<never>(() => {}),
  }; });
  const runner = new LocalRequestRunner(create, { retainModel: true });
  const stages: string[] = [];
  const pending = runner.run({ prompt: 'private', onProgress: updates, onStage: value => stages.push(value) });
  const rejected = expect(pending).rejects.toThrow(/cancel/);
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  expect(stages.at(-1)).toBe(stage); runner.cancel();
  expect(runner.isRunning).toBe(false); expect(signals[0].aborted).toBe(true);
  progress?.(50); expect(updates).not.toHaveBeenCalled(); await rejected;
  create.mockReturnValue({ initializeDeviceModel: async () => {}, generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }) } as never);
  await expect(runner.run({ prompt: 'recovery' })).resolves.toMatchObject({ text: 'ok' }); runner.release();
});
it('retires incompatible structured and image configurations and expires an idle model', async () => {
  vi.useFakeTimers(); const signals: AbortSignal[] = [];
  const create = vi.fn((signal: AbortSignal) => { signals.push(signal); return { initializeDeviceModel: async () => {}, generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }) }; });
  const runner = new LocalRequestRunner(create, { retainModel: true, idleTtlMs: 50 });
  await runner.run({ prompt: 'text' }); await runner.run({ prompt: 'schema', structured: true });
  expect(signals[0].aborted).toBe(true);
  await runner.run({ prompt: [{ type: 'text', text: 'image' }, { type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'eA==' } }], structured: true, image: true });
  expect(signals[1].aborted).toBe(true); expect(create).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(50); expect(signals[2].aborted).toBe(true);
  await runner.run({ prompt: 'after idle', structured: true, image: true }); expect(create).toHaveBeenCalledTimes(4); runner.release();
});
it('reports cold and warm timings with first chunk measured from generation start', async () => {
  vi.useFakeTimers();
  let observe: (() => void) | undefined;
  const metrics: unknown[] = [];
  const runner = new LocalRequestRunner(() => ({
    initializeDeviceModel: async () => { await new Promise(r => setTimeout(r, 10)); },
    setFirstChunkObserver: listener => { observe = listener; },
    generateContent: async () => { await new Promise(r => setTimeout(r, 5)); observe?.(); await new Promise(r => setTimeout(r, 5)); return { response: { inferenceSource: 'on_device', text: () => 'ok' } }; },
  }), { retainModel: true });
  const cold = runner.run({ prompt: 'private', onMetrics: m => metrics.push(m) });
  await vi.advanceTimersByTimeAsync(20); await cold;
  const warm = runner.run({ prompt: 'other private', onMetrics: m => metrics.push(m) });
  await vi.advanceTimersByTimeAsync(10); await warm;
  expect(metrics).toEqual([
    { operation: 'extraction', status: 'passed', modelReused: false, initializationMs: 10, firstChunkLatencyMs: 5, generationMs: 10, totalMs: 20 },
    { operation: 'extraction', status: 'passed', modelReused: true, initializationMs: 0, firstChunkLatencyMs: 5, generationMs: 10, totalMs: 10 },
  ]);
  runner.release();
});
it('retains one compatible SDK model without repeating initialization', async () => {
  const signals: AbortSignal[] = [];
  const initializeDeviceModel = vi.fn(async () => {});
  const generateContent = vi.fn(async () => ({ response: { inferenceSource: 'on_device', text: () => 'ok' } }));
  const create = vi.fn((signal: AbortSignal) => { signals.push(signal); return { initializeDeviceModel, generateContent }; });
  const runner = new LocalRequestRunner(create, { retainModel: true, idleTtlMs: 120000 });
  await runner.run({ prompt: 'first' }); await runner.run({ prompt: 'second' });
  expect(create).toHaveBeenCalledTimes(1); expect(initializeDeviceModel).toHaveBeenCalledTimes(1);
  expect(generateContent).toHaveBeenNthCalledWith(2, 'second'); expect(signals[0].aborted).toBe(false);
  runner.release(); expect(signals[0].aborted).toBe(true);
});
