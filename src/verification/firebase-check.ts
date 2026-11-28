import { getGenerativeModel } from 'firebase/ai';
import { ai } from '../lib/firebase';
import { localModelParams, requireOnDevice } from '../ai/local-policy';
import { extractCapsule } from '../ai/product-ai';
import { whileOffline } from '../ai/offline-guard';
const note = 'Motor stalls above 30% duty cycle. Replaced motor driver. Voltage appears normal. Problem remains unresolved.';
const online = document.querySelector<HTMLButtonElement>('#online')!;
const offline = document.querySelector<HTMLButtonElement>('#offline')!;
const output = document.querySelector('#report')!;
const report: Record<string, unknown> = { scope: 'real Firebase SDK; synthetic input; no cloud fallback', status: 'idle' };
const draw = () => { output.textContent = JSON.stringify(report, null, 2); };
function errorText(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/AIza[\w-]+/g, '[redacted]'); }
online.onclick = async () => {
  if (online.disabled) return;
  online.disabled = offline.disabled = true;
  report.status = 'running'; draw();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    document.title = 'RelayTrace Firebase Check — plain running';
    const model = getGenerativeModel(ai, localModelParams(false, controller.signal));
    await model.initializeDeviceModel();
    const started = performance.now();
    const stream = await model.generateContentStream('Say OK.');
    const consume = (async () => { for await (const chunk of stream.stream) {
      if (chunk.inferenceSource) requireOnDevice(chunk.inferenceSource);
    } })();
    const [response] = await Promise.all([stream.response, consume]);
    requireOnDevice(response.inferenceSource);
    report.plain = { status: 'passed', source: response.inferenceSource, text: response.text(), elapsedMs: Math.round(performance.now() - started) };
    controller.abort(); clearTimeout(timeout); draw();
    document.title = 'RelayTrace Firebase Check — JSON running';
    const jsonStart = performance.now();
    const result = await extractCapsule({ note });
    report.structured = { status: 'passed', ...result, elapsedMs: Math.round(performance.now() - jsonStart) };
    report.status = 'passed'; document.title = 'RelayTrace Firebase Check — PASSED online'; offline.disabled = false;
  } catch (e) { report.status = 'failed'; report.error = errorText(e); document.title = 'RelayTrace Firebase Check — FAILED'; }
  finally { controller.abort(); clearTimeout(timeout); online.disabled = false; draw(); }
};
offline.onclick = async () => {
  online.disabled = offline.disabled = true; report.status = 'offline running'; draw();
  try {
    const started = performance.now();
    const result = await whileOffline(() => extractCapsule({ note }));
    report.offline = { status: 'passed', ...result, elapsedMs: Math.round(performance.now() - started), continuousOffline: true };
    report.status = 'passed'; document.title = 'RelayTrace Firebase Check — PASSED offline';
  } catch (e) { report.offline = { status: 'failed', error: errorText(e) }; document.title = 'RelayTrace Firebase Check — offline FAILED'; }
  finally { online.disabled = false; offline.disabled = false; draw(); }
};
