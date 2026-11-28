import type { LocalInferenceMetrics } from '../ai/product-ai';
import './inference.css';
export function LocalInferenceControls({ busy, preparing, onPrepare, onRelease }: {
  busy: boolean; preparing: boolean; onPrepare(): void; onRelease(): void;
}) {
  return <section className="rt-device-tools" aria-label="Local model preparation">
    <div className="rt-actions"><button disabled={busy} onClick={onPrepare}>{preparing ? 'Preparing on-device AI…' : 'Prepare on-device AI'}</button><button disabled={busy} onClick={onRelease}>Release idle model</button></div>
    <p>Optional warm-up uses a short synthetic local request. No notes or photos are used. One compatible SDK model is retained briefly while idle; browser latency can still vary.</p>
  </section>;
}
export function LocalLatencyPanel({ metrics }: { metrics: LocalInferenceMetrics | null }) {
  if (!metrics) return null;
  return <section className="rt-latency" aria-label="Last local inference latency" role="status" aria-live="polite">
    <h3>Last local request · {metrics.operation} · {metrics.status}</h3>
    <dl><dt>Model</dt><dd>{metrics.modelReused ? 'Warm SDK instance reused' : 'Cold SDK instance'}</dd>
      <dt>Preparation</dt><dd>{Math.round(metrics.initializationMs)} ms</dd>
      <dt>First text chunk</dt><dd>{metrics.firstChunkLatencyMs === null ? 'No text chunk received' : `${Math.round(metrics.firstChunkLatencyMs)} ms`}</dd>
      <dt>Generation</dt><dd>{Math.round(metrics.generationMs)} ms</dd><dt>Total</dt><dd>{Math.round(metrics.totalMs)} ms</dd></dl>
    <p>SDK first-chunk timing includes session creation, not just model token generation. Timings stay on this device; no prompt or photo content is recorded in metrics.</p>
  </section>;
}
