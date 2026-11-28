// Component regression fixture: deferred module/SDK TEST DOUBLES, never real inference.
import { createRoot, type Root } from 'react-dom/client';
import { Capture } from '../../src/ui/ProductApp'; // Exported only by the test server transform.
import { LocalRequestRunner } from '../../src/ai/local-request';

// Real lifetime runner, synthetic SDK adapter: no Firebase/native model calls.
const runnerSignals: AbortSignal[] = [];
let runnerCancels = 0;
const runner = new LocalRequestRunner(signal => {
  runnerSignals.push(signal);
  return {
    initializeDeviceModel: () => new Promise<void>(() => {}),
    generateContent: async () => { throw new Error('TEST DOUBLE must remain in initialization'); },
  };
});
const runnerService = {
  extractCapsule: (input: any) => runner.run({ ...input, prompt: 'TEST DOUBLE extraction lifetime', operation: 'extraction' }),
  prepareLocalModel: (input: any) => runner.run({ ...input, prompt: 'TEST DOUBLE warmup lifetime', operation: 'warmup' }),
  cancelLocalExtraction: () => { runnerCancels++; runner.cancel(); },
};

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const modules: ReturnType<typeof deferred<any>>[] = [];
const calls: any[] = [];
const cancelled: number[] = [];
let releases = 0;
const roots = new Map<string, Root>();
let sdkOwner: any;
function start(kind: string, input: any) {
  const work = deferred<any>();
  const controller = new AbortController();
  const call = { kind, input, work, controller, id: calls.length };
  calls.push(call); sdkOwner = call;
  input.onStage?.(`TEST DOUBLE ${kind} ${call.id}`);
  return work.promise;
}
const service = {
  extractCapsule: (input: any) => start('extract', input),
  prepareLocalModel: (input: any) => start('prepare', input),
  cancelLocalExtraction: () => {
    if (sdkOwner) { cancelled.push(sdkOwner.id); sdkOwner.controller.abort(); sdkOwner = undefined; }
  },
  releaseLocalModel: () => { releases++; },
  releaseIdleLocalModel: () => { releases++; },
};
function mount(id = 'a') {
  const node = document.createElement('section'); node.id = `capture-${id}`; document.body.append(node);
  const root = createRoot(node); roots.set(id, root);
  root.render(<Capture projectId={`TEST-DOUBLE-${id}`} onSaved={async () => {}} />);
}
(window as any).__captureTest = {
  loadService: () => { const module = deferred<any>(); modules.push(module); return module.promise; },
  resolveModule: (id: number) => modules[id].resolve(service),
  runner,
  releaseCount: () => releases,
  resolveRunnerModule: async (id: number) => {
    // Same real runner for active SDK work and the production idle-release guard.
    const { releaseLocalModel, releaseIdleLocalModel } = await import('../../src/ai/product-ai');
    modules[id].resolve({ ...runnerService, releaseLocalModel, releaseIdleLocalModel });
  },
  runnerSnapshot: () => ({ running: runner.isRunning, cancelled: runnerCancels, aborted: runnerSignals.map(signal => signal.aborted) }),
  rejectModule: (id: number) => modules[id].reject(new Error(`TEST DOUBLE late module rejection ${id}`)),
  emit: (id: number) => {
    calls[id].input.onStage?.(`STALE TEST DOUBLE ${id}`);
    calls[id].input.onMetrics?.({ operation: 'extraction', status: 'failed', modelReused: false, initializationMs: 991, firstChunkLatencyMs: null, generationMs: 992, totalMs: 1983 });
  },
  settle: (id: number, outcome: string) => {
    if (sdkOwner === calls[id]) sdkOwner = undefined;
    if (outcome === 'reject') calls[id].work.reject(new Error(`TEST DOUBLE late SDK rejection ${id}`));
    else calls[id].work.resolve({ source: 'on_device', fields: { observation: [`TEST DOUBLE draft ${id}`], attempted: [], changed: [], result: [], unresolved: [], next_check: [] } });
  },
  snapshot: () => ({ modules: modules.length, calls: calls.map(({ id, kind, controller }) => ({ id, kind, aborted: controller.signal.aborted })), cancelled: [...cancelled] }),
  mount,
  unmount: (id = 'a') => { roots.get(id)?.unmount(); roots.delete(id); document.getElementById(`capture-${id}`)?.remove(); },
};
mount();
