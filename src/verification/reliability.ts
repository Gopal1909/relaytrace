import { capsulePrompt, parseCapsule } from '../ai/capsule';
import type { LocalInferenceMetrics, LocalRequestRunner } from '../ai/local-request';

export const syntheticMotorNote = 'Motor stalls above 30% duty cycle. Replaced motor driver. Voltage appears normal. Problem remains unresolved.';
export interface ReliabilityTrial {
  id: string; arm: 'fresh' | 'bootstrap' | 'reused'; status: LocalInferenceMetrics['status'];
  source: 'on_device' | null; metrics: LocalInferenceMetrics | null; errorCode?: string;
}
const plan = [
  { id: 'fresh-1', arm: 'fresh' }, { id: 'bootstrap', arm: 'bootstrap' },
  { id: 'reused-1', arm: 'reused' }, { id: 'fresh-2', arm: 'fresh' }, { id: 'reused-2', arm: 'reused' },
] as const;
function latency(trials: ReliabilityTrial[]) {
  const values = trials.filter(t => t.status === 'passed' && t.metrics).map(t => t.metrics!.totalMs).sort((a, b) => a - b);
  const n = values.length; const mid = Math.floor(n / 2);
  return n ? { count: n, minMs: values[0], medianMs: n % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2, maxMs: values[n - 1] } : null;
}
export function summarizeReliability(trials: ReliabilityTrial[]) {
  const measured = trials.filter(t => t.arm !== 'bootstrap');
  const successes = measured.filter(t => t.status === 'passed' && t.source === 'on_device');
  const reused = successes.filter(t => t.arm === 'reused' && t.metrics?.modelReused);
  return {
    decision: (measured.length === 4 && successes.length === 4 && reused.length === 2 ? 'GO' : 'NO-GO') as 'GO' | 'NO-GO',
    decisionScope: 'Small local-inference smoke test only; not production reliability certification or full MVP acceptance.',
    measured: { planned: 4, attempted: measured.length, succeeded: successes.length,
      successRate: measured.length ? successes.length / measured.length : null, skipped: 4 - measured.length },
    freshLatency: latency(measured.filter(t => t.arm === 'fresh')),
    reusedLatency: latency(measured.filter(t => t.arm === 'reused' && t.metrics?.modelReused)),
  };
}
let running = false;
export async function runReliabilityBatch(factory: (retain: boolean) => LocalRequestRunner,
  options: { signal?: AbortSignal; onTrial?: (trial: ReliabilityTrial) => void } = {}) {
  if (running) throw new Error('A reliability batch is already running.');
  running = true;
  let fresh: LocalRequestRunner | undefined; let shared: LocalRequestRunner | undefined;
  const trials: ReliabilityTrial[] = []; const started = performance.now();
  let stopReason: string | null = null; let failures = 0;
  const cancel = () => { fresh?.cancel(); shared?.cancel(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    fresh = factory(false); shared = factory(true);
    for (const item of plan) {
      if (options.signal?.aborted) { stopReason = 'cancelled'; break; }
      const remaining = 120000 - (performance.now() - started);
      if (remaining <= 5000) { stopReason = 'batch-budget-exhausted'; break; }
      const trial: ReliabilityTrial = { ...item, status: 'failed', source: null, metrics: null };
      const runner = item.arm === 'fresh' ? fresh : shared;
      try {
        const response = await runner.run({ structured: true,
          operation: item.arm === 'bootstrap' ? 'warmup' : 'extraction', prompt: capsulePrompt(syntheticMotorNote),
          initializationTimeoutMs: 5000, generationTimeoutMs: Math.min(20000, remaining - 5000),
          onMetrics: metrics => { trial.metrics = metrics; trial.status = metrics.status; },
          format: text => {
            const fields = parseCapsule(text);
            if (Object.entries(fields).some(([key, value]) => value.length > (key === 'next_check' ? 0 : 1))) throw new Error('Compact output limit exceeded.');
            return JSON.stringify(fields);
          },
        });
        trial.source = response.source; trial.status = 'passed'; failures = 0;
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        trial.errorCode = typeof code === 'string' && /^[a-zA-Z0-9_/-]+$/.test(code) ? code : trial.status;
        failures++;
      }
      trials.push(trial);
      options.onTrial?.(structuredClone(trial));
      if (options.signal?.aborted) { stopReason = 'cancelled'; break; }
      if (failures >= 2) { stopReason = 'two-consecutive-failures'; break; }
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    fresh?.release(); shared?.release(); running = false;
  }
  return { scope: 'Firebase ONLY_ON_DEVICE; fixed synthetic note; no cloud fallback', trials,
    elapsedMs: performance.now() - started, stopReason, ...summarizeReliability(trials) };
}
