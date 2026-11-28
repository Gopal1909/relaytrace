import type { Part } from 'firebase/ai';
import { requireOnDevice } from './local-policy';

export type LocalPrompt = string | Part[];
export type LocalPhase = 'initializing' | 'generating' | 'validating';
export interface LocalInferenceMetrics {
  operation: 'warmup' | 'extraction';
  status: 'passed' | 'failed' | 'cancelled' | 'timed_out';
  modelReused: boolean;
  initializationMs: number;
  firstChunkLatencyMs: number | null;
  generationMs: number;
  totalMs: number;
  interruptedStage?: string;
}
export interface LocalModel {
  /** Optional hook on our adapter, not a Firebase SDK method. */
  setFirstChunkObserver?(listener: (() => void) | undefined): void;
  initializeDeviceModel(progress?: (value: number) => void): Promise<void>;
  generateContent(prompt: LocalPrompt): Promise<{ response: { inferenceSource?: unknown; text(): string } }>;
}
type Options = {
  operation?: LocalInferenceMetrics['operation'];
  onMetrics?: (metrics: LocalInferenceMetrics) => void;
  prompt: LocalPrompt;
  preparePrompt?: (signal: AbortSignal) => Promise<LocalPrompt>;
  image?: boolean;
  structured?: boolean;
  format?: (text: string) => string;
  onStage?: (phase: LocalPhase) => void;
  onProgress?: (value: number) => void;
  initializationTimeoutMs?: number;
  generationTimeoutMs?: number;
};

/** One active local SDK operation per page. No cloud routing or native API replacement. */
export class LocalRequestRunner {
  private active: AbortController | null = null;
  private retained: { model: LocalModel; controller: AbortController; structured: boolean; image: boolean } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleDeadline: number | undefined;
  constructor(private readonly createModel: (signal: AbortSignal, structured: boolean, image: boolean) => LocalModel,
    private readonly config: { retainModel?: boolean; idleTtlMs?: number } = {}) {}
  release(): void {
    this.cancel();
  }
  get isRunning(): boolean { return this.active !== null; }

  cancel(): void {
    clearTimeout(this.idleTimer);
    this.idleDeadline = undefined;
    const controller = this.active;
    this.active = null;
    controller?.abort(new Error('Local request cancelled.'));
    this.retained?.controller.abort(new Error('Local request cancelled.'));
    this.retained = null;
  }

  private async bounded<T>(operation: () => Promise<T>, controller: AbortController, phase: LocalPhase | 'preprocessing', timeoutMs: number): Promise<T> {
    controller.signal.throwIfAborted();
    const deadline = performance.now() + timeoutMs;
    const expire = () => controller.abort(new Error(
      `Timed out during ${phase} after ${Math.round(timeoutMs / 1000)} seconds. Chrome did not complete this stage. No cloud fallback was used.`,
    ));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new Error('Local request cancelled.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(expire, timeoutMs);
    });
    try {
      // Invoke immediately, before any await, to preserve the original button gesture.
      const value = await Promise.race([operation(), interrupted]);
      // Background tabs may delay timers; late success must still miss its deadline.
      if (performance.now() >= deadline) expire();
      controller.signal.throwIfAborted();
      return value;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async run(options: Options): Promise<{ source: 'on_device'; text: string }> {
    if (this.active) throw new Error('Another local inference request is already running. Cancel it first.');
    clearTimeout(this.idleTimer);
    if (this.idleDeadline !== undefined && performance.now() >= this.idleDeadline) this.release();
    this.idleDeadline = undefined;
    if (this.retained && (this.retained.structured !== (options.structured ?? false) || this.retained.image !== (options.image ?? false))) this.release();
    const reused = !!this.retained;
    const controller = this.retained?.controller ?? new AbortController();
    this.active = controller;
    let passed = false;
    let finished = false;
    const started = performance.now();
    let phase: LocalPhase | 'preprocessing' = options.preparePrompt ? 'preprocessing' : 'initializing';
    let initializationStarted: number | undefined;
    let generationStarted: number | undefined;
    let generationEnded: number | undefined;
    let model: LocalModel | undefined;
    const metrics: LocalInferenceMetrics = { operation: options.operation ?? 'extraction', status: 'failed', modelReused: reused,
      initializationMs: 0, firstChunkLatencyMs: null, generationMs: 0, totalMs: 0 };
    try {
      const prompt = options.preparePrompt
        ? await this.bounded(() => options.preparePrompt!(controller.signal), controller, 'preprocessing', 30000) : options.prompt;
      controller.signal.throwIfAborted();
      phase = 'initializing';
      initializationStarted = performance.now();
      options.onStage?.('initializing');
      controller.signal.throwIfAborted();
      model = this.retained?.model ?? this.createModel(controller.signal, options.structured ?? false, options.image ?? false);
      const currentModel = model;
      if (!reused) await this.bounded(() => currentModel.initializeDeviceModel(value => {
        if (!finished && this.active === controller && !controller.signal.aborted) options.onProgress?.(value);
      }), controller, 'initializing', options.initializationTimeoutMs ?? 120_000);
      controller.signal.throwIfAborted();
      if (this.config.retainModel) this.retained = { model, controller, structured: options.structured ?? false, image: options.image ?? false };
      controller.signal.throwIfAborted();
      metrics.initializationMs = reused ? 0 : performance.now() - initializationStarted;
      phase = 'generating';
      options.onStage?.(phase);
      generationStarted = performance.now();
      model.setFirstChunkObserver?.(() => {
        if (!finished && this.active === controller && !controller.signal.aborted && metrics.firstChunkLatencyMs === null) {
          metrics.firstChunkLatencyMs = performance.now() - generationStarted!;
        }
      });
      const result = await this.bounded(() => currentModel.generateContent(prompt), controller,
        'generating', options.generationTimeoutMs ?? 60_000);
      generationEnded = performance.now();
      controller.signal.throwIfAborted();
      phase = 'validating';
      options.onStage?.(phase);
      controller.signal.throwIfAborted();
      requireOnDevice(result.response.inferenceSource);
      const raw = result.response.text();
      const text = options.format ? options.format(raw) : raw;
      controller.signal.throwIfAborted();
      passed = true;
      return { source: result.response.inferenceSource, text };
    } finally {
      finished = true;
      model?.setFirstChunkObserver?.(undefined);
      const ended = performance.now();
      metrics.status = passed ? 'passed' : controller.signal.aborted
        ? (controller.signal.reason instanceof Error && controller.signal.reason.message.startsWith('Timed out') ? 'timed_out' : 'cancelled') : 'failed';
      if (!passed) metrics.interruptedStage = phase;
      if (phase === 'initializing' && !reused && initializationStarted !== undefined) metrics.initializationMs = ended - initializationStarted;
      metrics.generationMs = generationStarted === undefined ? 0 : (generationEnded ?? ended) - generationStarted;
      metrics.totalMs = ended - started;
      if (!passed || !this.config.retainModel) {
        controller.abort();
        if (this.retained?.controller === controller) this.retained = null;
      } else {
        const ttl = this.config.idleTtlMs ?? 120_000;
        this.idleDeadline = performance.now() + ttl;
        this.idleTimer = setTimeout(() => this.release(), ttl);
      }
      if (this.active === controller) this.active = null;
      // Observability must not turn a completed local operation into a failure.
      try { options.onMetrics?.({ ...metrics }); } catch { /* consumer callback */ }
    }
  }
}
