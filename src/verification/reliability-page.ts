import { SDK_VERSION } from 'firebase/app';
import { createLocalInferenceRunner } from '../ai/product-ai';
import { runReliabilityBatch, type ReliabilityTrial } from './reliability';
const run = document.querySelector<HTMLButtonElement>('#run')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const output = document.querySelector<HTMLPreElement>('#report')!;
let active: AbortController | null = null;
let report: Record<string, unknown> = { status: 'idle', sdkVersion: SDK_VERSION, evidence: 'No inference executed yet.' };
function draw() { output.textContent = JSON.stringify(report, null, 2); download.disabled = false; }
run.onclick = async () => {
  if (active) return;
  const controller = new AbortController(); active = controller; run.disabled = true; cancel.disabled = false;
  report = { status: 'running', sdkVersion: SDK_VERSION, scope: 'Real Firebase ONLY_ON_DEVICE; synthetic input only', trials: [] }; draw();
  document.title = 'RelayTrace Reliability - running';
  try {
    // Readiness is not inference proof. Never start a multi-GB model download in a clean profile.
    const provider = (globalThis as unknown as { LanguageModel?: { availability(options: unknown): Promise<string> } }).LanguageModel;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const availability = provider ? await Promise.race([
      provider.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('readiness-timeout'), 5000); }),
    ]).finally(() => clearTimeout(timer)) : 'api-absent';
    controller.signal.throwIfAborted();
    if (availability !== 'available') {
      report = { ...report, status: 'blocked', readiness: availability, decision: 'NO-GO',
        reason: 'Model not ready in this profile. No inference success rate is measurable; no automatic model download was started.', measured: null };
    } else {
      const rows: ReliabilityTrial[] = [];
      const result = await runReliabilityBatch(createLocalInferenceRunner, { signal: controller.signal,
        onTrial: trial => { rows.push(trial); report = { ...report, trials: rows }; draw(); } });
      report = { ...result, sdkVersion: SDK_VERSION, status: 'complete', readiness: availability };
    }
  } catch (error) {
    report = { ...report, status: controller.signal.aborted ? 'cancelled' : 'failed', decision: 'NO-GO',
      errorCode: controller.signal.aborted ? 'cancelled' : 'reliability-run-failed' };
  } finally {
    if (active === controller) active = null;
    run.disabled = false; cancel.disabled = true; draw();
    document.title = `RelayTrace Reliability - ${report.decision || report.status}`;
  }
};
cancel.onclick = () => active?.abort(new Error('User cancelled the bounded test.'));
window.addEventListener('pagehide', () => active?.abort());
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'relaytrace-reliability.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
draw();
