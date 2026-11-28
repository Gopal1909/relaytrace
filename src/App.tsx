import { useEffect, useState } from 'react';
import { getGenerativeModel } from 'firebase/ai';
import { ai, appCheckMode, copyAppCheckDebugToken, verifyAppCheck } from './lib/firebase';
import { capsulePrompt, parseCapsule } from './ai/capsule';
import { localModelParams } from './ai/local-policy';
import { whileOffline } from './ai/offline-guard';
import { LocalRequestRunner, type LocalPhase } from './ai/local-request';

type PromptAPI = { availability: (options?: unknown) => Promise<string> };
type Result = { status: 'idle' | 'running' | 'passed' | 'failed'; source?: string; text?: string; error?: string };
type Kind = 'local' | 'structured' | 'offline';
type Operation = { kind: Kind; phase: LocalPhase; startedAt: number; visibility: string; userActivation: boolean };
const phaseLabels: Record<LocalPhase, string> = {
  initializing: 'Preparing the on-device model',
  generating: 'Creating Chrome session / generating on-device text',
  validating: 'Validating the local response',
};

const note = 'Motor stalls above 30% duty cycle. Replaced motor driver. Voltage appears normal. Problem remains unresolved.';
const prompt = `Summarize only the facts in this troubleshooting note in one sentence. Do not invent measurements or suggest repairs. Note: ${note}`;
const requests = new LocalRequestRunner((signal, structured) => getGenerativeModel(ai, localModelParams(structured, signal)));

function safeError(error: unknown): string {
  let text = error instanceof Error ? error.message : 'Unknown inference error';
  for (const value of Object.values(import.meta.env)) {
    if (typeof value === 'string' && value.length > 8) text = text.split(value).join('[redacted]');
  }
  return text.replace(/AIza[\w-]+/g, '[redacted]');
}

export function App() {
  const [readiness, setReadiness] = useState('Checking browser Prompt API…');
  const [local, setLocal] = useState<Result>({ status: 'idle' });
  const [structured, setStructured] = useState<Result>({ status: 'idle' });
  const [offline, setOffline] = useState<Result>({ status: 'idle' });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [attestation, setAttestation] = useState('Not verified');
  const [online, setOnline] = useState(navigator.onLine);
  const busy = operation !== null;
  useEffect(() => {
    if (operation) document.title = `RelayTrace — ${operation.kind}: ${operation.phase}`;
    else if (structured.status !== 'idle' || offline.status !== 'idle') {
      document.title = `RelayTrace — JSON ${structured.status}${structured.source ? ' '+structured.source : ''} | OFFLINE ${offline.status}${offline.source ? ' '+offline.source : ''}`;
    } else document.title = local.status === 'passed' ? `RelayTrace — VERIFIED ${local.source}`
      : local.status === 'failed' ? 'RelayTrace — local test blocked' : `RelayTrace — ${readiness}`;
  }, [operation, local, structured, offline, readiness]);
  useEffect(() => {
    if (!operation) return;
    const tick = () => setElapsed(Math.floor((Date.now() - operation.startedAt) / 1000));
    tick(); const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [operation]);
  useEffect(() => {
    const api = (globalThis as typeof globalThis & { LanguageModel?: PromptAPI }).LanguageModel;
    if (!api) setReadiness('LanguageModel API is absent in this browser/profile. No cloud fallback will be used.');
    else api.availability(localModelParams().onDeviceParams?.createOptions)
      .then(value => setReadiness(`Text-only Prompt API availability: ${value}`)).catch(e => setReadiness(safeError(e)));
    const update = () => setOnline(navigator.onLine);
    addEventListener('online', update); addEventListener('offline', update);
    return () => { removeEventListener('online', update); removeEventListener('offline', update); requests.cancel(); };
  }, []);

  async function runProbe(kind: Kind) {
    if (requests.isRunning) return;
    const update = kind === 'local' ? setLocal : kind === 'structured' ? setStructured : setOffline;
    update({ status: 'running' }); setProgress(null); setElapsed(0);
    const startedAt = Date.now();
    const visibility = globalThis.document?.visibilityState ?? 'unavailable';
    const userActivation = navigator.userActivation?.isActive ?? false;
    try {
      const extract = () => requests.run({
        structured: kind !== 'local',
        prompt: kind === 'local' ? prompt : capsulePrompt(note),
        format: kind === 'local' ? undefined : text => JSON.stringify(parseCapsule(text), null, 2),
        onStage: phase => setOperation({ kind, phase, startedAt, visibility, userActivation }),
        onProgress: value => setProgress(Math.round(value * 100)),
      });
      const result = await (kind === 'offline' ? whileOffline(extract) : extract());
      update({ status: 'passed', ...result });
    } catch (e) { update({ status: 'failed', error: safeError(e) }); }
    finally { setOperation(null); }
  }

  return <main>
    <header><strong>RelayTrace</strong><span>PHASE 0 · FEASIBILITY ONLY</span></header>
    <h1>Local inference feasibility</h1>
    <p className="intro">Prove the device path before building the product. A cloud response does not pass this gate.</p>
    <section aria-labelledby="environment-title">
      <h2 id="environment-title">Runtime</h2>
      <p><strong>{online ? 'ONLINE' : 'OFFLINE'}</strong> · App Check mode: {appCheckMode}</p>
      <p id="readiness">{readiness}</p>
      <p>Text-only probe · <code>ONLY_ON_DEVICE</code> · no automatic cloud fallback. Keep this tab visible.</p>
      <div id="request-progress" role="status" aria-live="polite">
        {operation ? <><p>{phaseLabels[operation.phase]} · <strong>{elapsed}s elapsed</strong></p>
          <p>At click: visibility {operation.visibility}; user activation {String(operation.userActivation)}. Initialization limit: 120s; generation/session limit: 60s.</p></> : <p>No local request is running.</p>}
      </div>
      <button disabled={!busy} onClick={() => requests.cancel()}>Cancel local request</button>
    </section>
    <section aria-labelledby="probe-title">
      <h2 id="probe-title">Genuine Firebase AI Logic local request</h2>
      {import.meta.env.DEV && <p><a href="/native-probe.html">Open native Chrome isolation diagnostic</a></p>}
      <p>Synthetic test note:</p><blockquote>{note}</blockquote>
      <button onClick={() => runProbe('local')} disabled={busy}>Run genuine local inference</button>
      {progress !== null && <p role="status">Model download: {progress}%</p>}
      <div id="local-result" data-status={local.status} role="status" aria-live="polite">
        <h3>{local.status === 'passed' ? 'ON DEVICE — VERIFIED' : local.status === 'failed' ? 'LOCAL TEST BLOCKED' : local.status === 'running' ? (operation ? phaseLabels[operation.phase] : 'Starting local request…') : 'Not tested'}</h3>
        {local.source && <p>SDK inferenceSource: <code>{local.source}</code></p>}
        {local.text && <pre>{local.text}</pre>}
        {local.error && <pre>{local.error}</pre>}
      </div>
    </section>
    <section aria-labelledby="json-title">
      <h2 id="json-title">Structured capsule and offline gates</h2>
      <p>All six fields must be arrays of strings. Output is an unconfirmed draft, not a diagnosis. These tests use only the synthetic note above.</p>
      <button onClick={() => runProbe('structured')} disabled={busy}>Run structured local extraction</button>
      <div id="json-result" data-status={structured.status} role="status"><h3>JSON: {structured.status} {structured.source}</h3><pre>{structured.text || structured.error}</pre></div>
      <p>For the offline test: keep this page and the prepared model loaded, use Chrome DevTools Network → Offline for this tab, then run the test. Do not reload while the tab is offline.</p>
      <button onClick={() => runProbe('offline')} disabled={busy || structured.status !== 'passed'}>Run offline structured extraction</button>
      <div id="offline-result" data-status={offline.status} role="status"><h3>OFFLINE JSON: {offline.status} {offline.source}</h3><pre>{offline.text || offline.error}</pre></div>
    </section>
    <section aria-labelledby="app-check-title">
      <h2 id="app-check-title">App Check attestation</h2>
      <p>Register the generated browser debug token directly in Firebase Console. Do not paste it into chat. Instructions: <code>docs/firebase-console.md</code>.</p>
      {import.meta.env.DEV && appCheckMode === 'debug' && <>
        <button onClick={async () => {
          try { await copyAppCheckDebugToken(); setCopyStatus('Copied privately. Paste directly into Firebase Console, not chat.'); }
          catch (e) { setCopyStatus(safeError(e)); }
        }}>Copy debug token privately</button><p role="status">{copyStatus}</p>
      </>}
      <button onClick={async () => {
        setAttestation('Verifying token exchange…');
        try { await verifyAppCheck(); setAttestation('VERIFIED — real App Check token exchange succeeded'); }
        catch (e) { setAttestation(safeError(e)); }
      }}>Verify App Check</button>
      <p id="app-check-result" role="status">{attestation}</p>
    </section>
    <footer>No workspace, upload, sync, or product features are enabled until local feasibility passes.</footer>
  </main>;
}
