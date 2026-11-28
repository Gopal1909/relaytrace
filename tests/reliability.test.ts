// Controlled adapters test orchestration only; NOT evidence of real inference.
import { afterEach, expect, it, vi } from 'vitest';
import { LocalRequestRunner } from '../src/ai/local-request';
import { runReliabilityBatch } from '../src/verification/reliability';
afterEach(() => vi.useRealTimers());
const empty = { observation: [], attempted: [], changed: [], result: [], unresolved: [], next_check: [] };
it('compares two fresh and two truly retained SDK executions, with one separately reported bootstrap', async () => {
  const factories = vi.fn((retainModel: boolean) => new LocalRequestRunner(() => ({ initializeDeviceModel: async () => {},
    generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => JSON.stringify(empty) } }),
  }), { retainModel }));
  const result = await runReliabilityBatch(factories);
  expect(result.trials).toHaveLength(5);
  expect(result.measured.attempted).toBe(4); expect(result.measured.succeeded).toBe(4);
  expect(result.measured.successRate).toBe(1); expect(result.decision).toBe('GO');
  expect(result.trials.filter(t => t.arm === 'reused').every(t => t.metrics?.modelReused)).toBe(true);
  expect(result.trials.every(t => t.source === 'on_device')).toBe(true);
  expect(factories.mock.calls.map(c => c[0])).toEqual([false, true]);
});
it('releases the batch lock after a factory failure so an explicit retry remains possible', async () => {
  await expect(runReliabilityBatch(() => { throw new Error('Synthetic factory failure'); })).rejects.toThrow('Synthetic factory failure');
  const create = (retainModel: boolean) => new LocalRequestRunner(() => ({ initializeDeviceModel: async () => {},
    generateContent: async () => ({ response: { inferenceSource: 'on_device', text: () => JSON.stringify(empty) } }),
  }), { retainModel });
  await expect(runReliabilityBatch(create)).resolves.toHaveProperty('decision', 'GO');
});
it('caps stalled generations, stops after two failures and never invents successful provenance', async () => {
  vi.useFakeTimers();
  const create = (retainModel: boolean) => new LocalRequestRunner(() => ({ initializeDeviceModel: async () => {},
    generateContent: () => new Promise<never>(() => {}),
  }), { retainModel });
  const pending = runReliabilityBatch(create);
  await vi.advanceTimersByTimeAsync(40001);
  const report = await pending;
  expect(report.trials).toHaveLength(2); expect(report.stopReason).toBe('two-consecutive-failures');
  expect(report.trials.every(t => t.status === 'timed_out' && t.source === null)).toBe(true);
  expect(report.measured.successRate).toBe(0); expect(report.freshLatency).toBe(null);
  expect(report.decision).toBe('NO-GO');
});
it('cancels an active SDK operation without starting the remainder of the batch', async () => {
  const controller = new AbortController();
  const create = (retainModel: boolean) => new LocalRequestRunner(() => ({ initializeDeviceModel: async () => {},
    generateContent: () => new Promise<never>(() => {}),
  }), { retainModel });
  const pending = runReliabilityBatch(create, { signal: controller.signal });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  controller.abort();
  const report = await pending;
  expect(report.trials).toHaveLength(1); expect(report.trials[0].status).toBe('cancelled');
  expect(report.trials[0].source).toBe(null); expect(report.stopReason).toBe('cancelled');
});
it('refuses a cloud final response even if it contains valid compact JSON', async () => {
  const create = (retainModel: boolean) => new LocalRequestRunner(() => ({ initializeDeviceModel: async () => {},
    generateContent: async () => ({ response: { inferenceSource: 'in_cloud', text: () => JSON.stringify(empty) } }),
  }), { retainModel });
  const report = await runReliabilityBatch(create);
  expect(report.trials.every(t => t.source === null && t.status === 'failed')).toBe(true);
  expect(report.decision).toBe('NO-GO'); expect(report.measured.succeeded).toBe(0);
});
