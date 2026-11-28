import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CircleDot, Cloud, FileText, FolderOpen, GitCommitHorizontal, Layers, Plus, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import type { CapsuleDraft } from '../ai/capsule';
import type { Capsule, Project, SharingPayload, SyncJob } from '../domain/types';
import type { LocalInferenceMetrics } from '../ai/product-ai';
import { LocalInferenceControls, LocalLatencyPanel } from './LocalInferenceControls';
import './product.css';

const fields = ['observation', 'attempted', 'changed', 'result', 'unresolved', 'next_check'] as const;
const labels: Record<typeof fields[number], string> = { observation: 'Observation', attempted: 'What was attempted', changed: 'What changed', result: 'Recorded result', unresolved: 'Still unresolved', next_check: 'Suggested next checks' };
type LocalCaptureRequest = { cancel?: () => void };
// The service's cancellation API targets a page-global runner. Only its UI owner
// may call it; an import-pending or rejected contender never acquires ownership.
let localSdkOwner: LocalCaptureRequest | null = null;
function ownLocalSdk(request: LocalCaptureRequest, cancel: () => void) {
  if (localSdkOwner) throw new Error('Another local request is already running. Cancel it or wait.');
  localSdkOwner = request;
  request.cancel = () => {
    if (localSdkOwner !== request) return;
    localSdkOwner = null;
    cancel();
  };
}
type Source = 'manual' | 'on_device';
type TextFields = Partial<Record<typeof fields[number], string>>;
export function validatePhoto(file: { type: string; size: number }): string {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size === 0) return 'Choose a PNG or JPEG photo.';
  if (file.size > 8 * 1024 * 1024) return 'Photo must be 8 MB or smaller.';
  return '';
}
export function draftFromText(text: TextFields): CapsuleDraft {
  return Object.fromEntries(fields.map(key => [key, (text[key] ?? '').split('\n').map(line => line.trim()).filter(Boolean)])) as CapsuleDraft;
}
export function canCommit(confirmed: boolean, source: Source | null, note: string, _draft: CapsuleDraft, hasPhoto = false): boolean {
  return confirmed && source !== null && Boolean(note.trim() || hasPhoto);
}
const localStore = async () => (await import('../storage/store')).store;
function message(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Device storage is full. Your input is still here. Free some browser storage or remove the photo, then retry.';
  return error instanceof Error ? error.message : 'The operation could not finish. Your input has been retained. Please retry.';
}
function date(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return online;
}
function Photo({ blob, alt, className = '' }: { blob: Blob; alt: string; className?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [blob]);
  return url ? <img className={`rt-photo ${className}`} src={url} alt={alt} /> : null;
}
function ErrorNotice({ children }: { children: ReactNode }) { return <div className="rt-error" role="alert">{children}</div>; }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="rt-empty"><GitCommitHorizontal size={32} aria-hidden="true" /><h3>{title}</h3><p>{children}</p></div>; }

export function ProductApp() { return <BrowserRouter><ProductShell /></BrowserRouter>; }
export function ProductShell() {
  const online = useOnline();
  return <div className="relaytrace"><a className="rt-skip" href="#rt-main">Skip to content</a><aside className="rt-sidebar"><Link className="rt-brand" to="/" aria-label="RelayTrace home"><span className="rt-brandmark"><Layers size={22} /></span><span>relaytrace<span className="rt-brand-sub">THE WORK CONTINUES.</span></span></Link><div className="rt-workspace">PERSONAL WORKSPACE <span>LOCAL</span></div><nav aria-label="Main navigation"><NavLink end to="/"><FolderOpen size={17} /> Project ledger</NavLink><a href="/firebase-check.html" aria-label="Real SDK acceptance checks"><ShieldCheck size={17} /> SDK acceptance <span className="rt-nav-arrow">↗</span></a><a href="/diagnostics"><CircleDot size={17} /> Diagnostics <span className="rt-nav-arrow">↗</span></a></nav><div className="rt-sidebar-bottom"><div className="rt-device"><ShieldCheck size={19} /><div>Your device. Your record.<small>Nothing shared automatically.</small></div></div><div className="rt-connect">{online ? <Wifi size={14} /> : <WifiOff size={14} />} {online ? 'Online' : 'Offline'}<span>LOCAL FIRST</span></div></div></aside><div className="rt-body"><header className="rt-topbar"><span>FIELD NOTES / STATE CAPSULES</span><span className="rt-tag"><span className="rt-dot" /> {online ? 'Online' : 'Offline'} · human-confirmed</span></header><main id="rt-main" tabIndex={-1}><Routes><Route path="/" element={<Dashboard />} /><Route path="/projects/:projectId/*" element={<ProjectWorkspace />} /><Route path="*" element={<div className="rt-page"><h1>Page not found</h1><Link to="/">Return to the ledger</Link></div>} /></Routes></main><footer className="rt-footer"><span>RELAYTRACE <span className="rt-footer-line">/</span> A record, not a diagnosis.</span><span>Final device & cloud acceptance: pending verification</span></footer></div></div>;
}
function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const navigate = useNavigate();
  const load = useCallback(async () => { setLoading(true); setError(''); try { setProjects(await (await localStore()).listProjects()); } catch (e) { setError(message(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const title = String(data.get('title') ?? '').trim(); if (!title) return; setCreating(true); setError(''); try { const project = await (await localStore()).createProject(title, String(data.get('description') ?? '').trim()); navigate(`/projects/${project.id}`); } catch (e) { setError(message(e)); } finally { setCreating(false); } }
  return <div className="rt-page"><div className="rt-breadcrumb">Workspace <span>/</span> Project ledger</div><div className="rt-heading-row"><div><p className="rt-eyebrow">THE PHYSICAL-WORK LEDGER</p><h1>Pick up where<br />you left off.</h1><p className="rt-intro">Keep the observation, the attempt, and the unknown.<br className="rt-desktop-break" /> Leave a clear trail for the next pair of hands.</p></div><button className="rt-primary" onClick={() => setShowForm(v => !v)} aria-expanded={showForm}><Plus size={17} /> New project</button></div><div className="rt-principles"><span><ShieldCheck size={18} /> Local by default</span><span><Check size={18} /> Confirmed by a human</span><span><Cloud size={18} /> Shared only with approval</span></div>{showForm && <form className="rt-panel rt-create" onSubmit={create}><div className="rt-section-heading"><h2>Start a project</h2><span className="rt-mono">01 / CREATE</span></div><label>Project name<input autoFocus required name="title" maxLength={120} placeholder="e.g. Workshop ventilation fan" /></label><label>Context <span className="rt-muted">(optional)</span><textarea name="description" rows={2} maxLength={4000} placeholder="What are you working on?" /></label><div className="rt-actions"><button className="rt-primary" disabled={creating}>{creating ? 'Creating locally…' : 'Create local project'}<ArrowRight size={16} /></button><button type="button" onClick={() => setShowForm(false)}>Cancel</button></div></form>}{error && <ErrorNotice>{error} <button onClick={() => void load()}>Retry loading</button></ErrorNotice>}<section aria-labelledby="projects-title"><div className="rt-section-heading"><h2 id="projects-title">Your projects <span className="rt-count">{projects.length}</span></h2><span className="rt-mono">STORED ON THIS DEVICE</span></div>{loading ? <p role="status" className="rt-loading">Opening local ledger…</p> : projects.length === 0 ? <Empty title="Every repair starts with a record.">Create your first project. No sample entries, no inferred history — just your work.</Empty> : <div className="rt-project-grid">{projects.map(project => <Link className="rt-project-card" key={project.id} to={`/projects/${project.id}`}><div className="rt-card-top"><span className="rt-folder"><FolderOpen size={22} /></span><span className="rt-mono">{project.id.slice(0, 8)}</span></div><h3>{project.title}</h3><p>{project.description || 'No context recorded yet.'}</p><div className="rt-card-bottom"><span>Updated {date(project.updatedAt)}</span><ArrowRight size={18} /></div></Link>)}</div>}</section><div className="rt-ledger-note"><span className="rt-mono">A NOTE ON TRUST</span><p>AI can help structure a note. It cannot verify the work.<br />You review every field before it becomes part of the record.</p></div></div>;
}
function ProjectWorkspace() {
  const { projectId = '' } = useParams();
  const [project, setProject] = useState<Project>();
  const [capsules, setCapsules] = useState<Capsule[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'timeline' | 'capture' | 'share'>('timeline');
  const load = useCallback(async () => { setError(''); try { const store = await localStore(); const [p, c, j] = await Promise.all([store.getProject(projectId), store.listCapsules(projectId), store.listJobs(projectId)]); setProject(p); setCapsules(c); setJobs(j); } catch (e) { setError(message(e)); } finally { setLoading(false); } }, [projectId]);
  useEffect(() => { setLoading(true); setProject(undefined); setTab('timeline'); void load(); }, [load]);
  if (loading) return <div className="rt-page" role="status">Opening local project…</div>;
  if (!project) return <div className="rt-page">{error ? <ErrorNotice>{error}<button onClick={() => void load()}>Retry</button></ErrorNotice> : <h1>Project not found on this device.</h1>}<Link to="/">Back to ledger</Link></div>;
  return <div className="rt-page"><Link className="rt-back" to="/"><ArrowLeft size={14} /> Project ledger</Link><div className="rt-heading-row rt-project-heading"><div><p className="rt-eyebrow">PROJECT <span className="rt-mono">/ {project.id.slice(0, 8)}</span></p><h1>{project.title}</h1><p className="rt-intro">{project.description || 'A clear record of the work, one confirmed state at a time.'}</p></div><button className="rt-primary" onClick={() => setTab('capture')}><Plus size={17} /> Capture state</button></div><div className="rt-tabs" role="tablist" aria-label="Project views" onKeyDown={event => { const order = ['timeline', 'capture', 'share'] as const; const index = order.indexOf(tab); const next = event.key === 'ArrowRight' ? order[(index + 1) % 3] : event.key === 'ArrowLeft' ? order[(index + 2) % 3] : event.key === 'Home' ? order[0] : event.key === 'End' ? order[2] : null; if (next) { event.preventDefault(); setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}>{(['timeline', 'capture', 'share'] as const).map(item => <button key={item} id={`tab-${item}`} role="tab" aria-selected={tab === item} aria-controls={`panel-${item}`} onClick={() => setTab(item)}>{item === 'timeline' ? 'Timeline' : item === 'capture' ? 'Capture state' : 'Share & handoff'}{item === 'timeline' && <span className="rt-count">{capsules.length}</span>}</button>)}</div>{error && <ErrorNotice>{error}<button onClick={() => void load()}>Retry loading</button></ErrorNotice>}<section id="panel-timeline" role="tabpanel" aria-labelledby="tab-timeline" hidden={tab !== 'timeline'}><Timeline capsules={capsules} onCapture={() => setTab('capture')} /></section><section id="panel-capture" role="tabpanel" aria-labelledby="tab-capture" hidden={tab !== 'capture'}><Capture key={projectId} projectId={projectId} onSaved={async () => { await load(); setTab('timeline'); }} /></section><section id="panel-share" role="tabpanel" aria-labelledby="tab-share" hidden={tab !== 'share'}><Sharing key={projectId} project={project} capsules={capsules} jobs={jobs} reload={load} /></section></div>;
}
function Timeline({ capsules, onCapture }: { capsules: Capsule[]; onCapture: () => void }) {
  if (!capsules.length) return <><Empty title="No states recorded. Yet.">Capture what you observed, what you tried, and what is still unknown.</Empty><button className="rt-primary" onClick={onCapture}><Plus size={16} /> Capture the first state</button></>;
  return <div className="rt-timeline">{[...capsules].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(capsule => <article className="rt-capsule" key={capsule.id}><div className="rt-commit-dot"><GitCommitHorizontal size={20} /></div><div className="rt-capsule-head"><span className="rt-mono">{capsule.id}</span><span className="rt-tag"><Check size={13} /> Human confirmed</span></div><div className="rt-meta">{date(capsule.createdAt)} · {capsule.source === 'on_device' ? 'On-device extraction · human reviewed' : 'Manual entry'}<br /><span className="rt-mono">parent / {capsule.parentId ?? 'root'}</span></div><div className="rt-field-grid">{fields.map(key => <div key={key} className={key === 'next_check' ? 'rt-suggestions' : ''}><h3>{labels[key]}</h3>{capsule.fields[key].length ? <ul>{capsule.fields[key].map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="rt-muted">Not recorded</p>}{key === 'next_check' && <small>Suggestions, not established facts.</small>}</div>)}</div>{capsule.photo && <Photo blob={capsule.photo} alt="Locally retained project evidence" />}<details><summary>Original note & local evidence</summary><p className="rt-original">{capsule.originalNote || 'No original note.'}</p><p className="rt-muted">Confirmed {date(capsule.confirmedAt)}. Photos stay out of sharing payloads.</p></details></article>)}</div>;
}
function Capture({ projectId, onSaved }: { projectId: string; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(''); const [photo, setPhoto] = useState<File>(); const [text, setText] = useState<TextFields>({});
  const [extracting, setExtracting] = useState(false); const [source, setSource] = useState<Source | null>(null); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [stage, setStage] = useState(''); const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [metrics, setMetrics] = useState<LocalInferenceMetrics | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const alive = useRef(true);
  const activeLocal = useRef<LocalCaptureRequest | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; const request = activeLocal.current; activeLocal.current = null; request?.cancel?.(); }; }, []);
  useEffect(() => { if (!extracting) return; const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)); tick(); const timer = setInterval(tick, 500); return () => clearInterval(timer); }, [extracting, startedAt]);
  const isCurrent = (request: LocalCaptureRequest) => alive.current && activeLocal.current === request;
  function localCallbacks(request: LocalCaptureRequest) {
    return {
      onMetrics: (value: LocalInferenceMetrics) => { if (isCurrent(request)) setMetrics(value); },
      onStage: (value: string) => { if (isCurrent(request)) setStage(({ initializing: 'Preparing on-device model…', generating: 'Generating on device…', validating: 'Validating response…' } as Record<string, string>)[value] || value); },
    };
  }
  function finishLocal(request: LocalCaptureRequest, cancel = false) {
    if (activeLocal.current !== request) return;
    activeLocal.current = null;
    if (cancel) request.cancel?.();
    else if (localSdkOwner === request) localSdkOwner = null;
    if (alive.current) { setBusy(false); setExtracting(false); setPreparing(false); }
  }
  function cancelLocal() {
    const request = activeLocal.current;
    if (!request) return;
    finishLocal(request, true);
    setStage('Local request cancelled. Your note and photo are retained; retry explicitly or use manual entry.');
  }
  async function extract() {
    if (busy || activeLocal.current) return;
    const request: LocalCaptureRequest = {}; activeLocal.current = request; setExtracting(true); setBusy(true); setStartedAt(Date.now()); setElapsed(0); setError(''); setConfirmed(false); setSource(null); setStage('Preparing on-device request…');
    try {
      const service = await import('../ai/product-ai'); if (!isCurrent(request)) return; ownLocalSdk(request, service.cancelLocalExtraction);
      const result = await service.extractCapsule({ note, photo, ...localCallbacks(request) });
      if (!isCurrent(request)) return;
      setText(Object.fromEntries(fields.map(key => [key, result.fields[key].join('\n')]))); setSource(result.source); setStage('On-device draft ready. Review every field.');
    } catch (e) { if (isCurrent(request)) { setStage(''); setError(`${message(e)} No AI draft was created. Your note and photo are retained. Retry explicitly or use manual entry; nothing was sent to the cloud.`); } }
    finally { finishLocal(request); }
  }
  async function prepare() {
    if (busy || activeLocal.current) return;
    const request: LocalCaptureRequest = {}; activeLocal.current = request; setPreparing(true); setExtracting(true); setBusy(true); setStartedAt(Date.now()); setElapsed(0); setError(''); setStage('Warming with a synthetic local prompt…');
    try {
      const service = await import('../ai/product-ai'); if (!isCurrent(request)) return; ownLocalSdk(request, service.cancelLocalExtraction);
      await service.prepareLocalModel({ ...localCallbacks(request) });
      if (isCurrent(request)) setStage('Warm-up completed. The compatible model is retained briefly while idle; browser latency may still vary.');
    } catch (e) { if (isCurrent(request)) { setStage(''); setError(`${message(e)} Warm-up did not complete. No private input or cloud fallback was used.`); } }
    finally { finishLocal(request); }
  }
  async function release() {
    if (busy || activeLocal.current) return; const request: LocalCaptureRequest = {}; activeLocal.current = request; setBusy(true); setExtracting(true); setStartedAt(Date.now()); setElapsed(0); setError(''); setStage('Releasing idle model…');
    try { const service = await import('../ai/product-ai'); if (isCurrent(request)) { service.releaseIdleLocalModel(); setStage('Idle model released. Your draft and local records are unchanged.'); } }
    catch (e) { if (isCurrent(request)) { setStage(''); setError(message(e)); } }
    finally { finishLocal(request); }
  }
  async function save() { const draft = draftFromText(text); if (busy || !canCommit(confirmed, source, note, draft, Boolean(photo))) return; setBusy(true); setError(''); try { await (await localStore()).saveCapsule({ projectId, originalNote: note, fields: draft, source: source!, confirmed: true, photo, photoName: photo?.name }); setNote(''); setPhoto(undefined); setText({}); setSource(null); setConfirmed(false); setStage(''); if (inputRef.current) inputRef.current.value = ''; await onSaved(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <div className="rt-capture-layout"><div><div className="rt-section-heading"><h2>Record the current state</h2><span className="rt-mono">01 / CAPTURE</span></div><p className="rt-muted">Write what happened. Missing facts stay missing.</p><LocalInferenceControls busy={busy} preparing={preparing} onPrepare={() => void prepare()} onRelease={() => void release()} /><LocalLatencyPanel metrics={metrics} />{extracting && <p className="rt-fine" role="status">Local request elapsed: {elapsed} s. You can cancel safely; no cloud fallback is used.</p>}<label className="rt-note-label">Field note<textarea disabled={busy} rows={7} maxLength={20000} value={note} onChange={e => { setNote(e.target.value); setConfirmed(false); setSource(current => current === 'on_device' ? null : current); }} placeholder="What did you observe? What did you try? What happened?" /></label><div className="rt-photo-input"><label htmlFor="rt-photo">Local evidence <span className="rt-muted">· optional PNG / JPEG, up to 8 MB</span></label><input ref={inputRef} disabled={busy} id="rt-photo" type="file" accept="image/png,image/jpeg" onChange={e => { const file = e.target.files?.[0]; if (!file) return; const invalid = validatePhoto(file); if (invalid) { setError(invalid); e.target.value = ''; return; } setPhoto(file); setError(''); setConfirmed(false); if (source === 'on_device') setSource(null); }} />{photo && <div className="rt-photo-preview"><Photo blob={photo} alt="Selected local evidence preview" /><button disabled={busy} onClick={() => { setPhoto(undefined); setConfirmed(false); if (source === 'on_device') setSource(null); if (inputRef.current) inputRef.current.value = ''; }}>Remove photo</button></div>}</div><div className="rt-actions"><button className="rt-primary" disabled={busy || (!note.trim() && !photo)} onClick={() => void extract()}><Layers size={16} />{busy && stage ? 'Working on device…' : 'Extract on device'}</button><button disabled={busy} onClick={() => { setSource('manual'); setConfirmed(false); setError(''); setStage('Manual entry — no AI inference performed.'); }}>Use manual entry</button>{extracting && <button onClick={cancelLocal}>Cancel local request</button>}</div><p className="rt-fine">On-device extraction never falls back to cloud. Availability depends on your browser and device. Uncommitted input stays in this open project; commit it before leaving or reloading.</p>{stage && <p role="status" className="rt-status">{stage}</p>}{error && <ErrorNotice>{error}</ErrorNotice>}</div><aside className="rt-process-note"><ShieldCheck size={24} /><h3>Evidence before inference.</h3><p>Four fields describe recorded facts. Unknowns remain explicit. Next checks are suggestions — never proof that a check was performed.</p><div className="rt-mono">CAPTURE → REVIEW → CONFIRM</div></aside>{source && <div className="rt-review"><div className="rt-section-heading"><h2>Review the capsule</h2><span className="rt-tag">{source === 'manual' ? 'Manual entry' : 'On-device draft'}</span></div><p className="rt-muted">Edit freely. One item per line. Leave unknown facts blank.</p><div className="rt-field-grid">{fields.map(key => <label key={key} className={key === 'next_check' ? 'rt-suggestions' : ''}>{labels[key]}{key === 'next_check' && <small>Proposals only. These are not recorded outcomes.</small>}<textarea disabled={busy} rows={3} value={text[key] ?? ''} onChange={e => { setText(current => ({ ...current, [key]: e.target.value })); setConfirmed(false); }} /></label>)}</div><label className="rt-consent"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>I have reviewed all six fields. Recorded facts reflect my observations, and suggested checks are not presented as facts.</span></label><div className="rt-actions"><button className="rt-primary" disabled={busy || !canCommit(confirmed, source, note, draftFromText(text), Boolean(photo))} onClick={() => void save()}><GitCommitHorizontal size={17} />{busy ? 'Please wait…' : 'Commit capsule locally'}</button><span className="rt-fine">Original note and photo retained on this device.</span></div></div>}</div>;
}
function Sharing({ project, capsules, jobs, reload }: { project: Project; capsules: Capsule[]; jobs: SyncJob[]; reload: () => Promise<void> }) {
  const online = useOnline(); const [selected, setSelected] = useState<string[]>([]); const [preview, setPreview] = useState<SharingPayload>(); const [handoffConsent, setHandoffConsent] = useState(false); const [syncConsent, setSyncConsent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [status, setStatus] = useState(''); const [handoff, setHandoff] = useState<{ text: string; source: 'in_cloud' }>();
  useEffect(() => { let active = true; setPreview(undefined); setHandoffConsent(false); setSyncConsent(false); setHandoff(undefined); setError(''); import('../domain/sharing').then(({ makeSharingPreview }) => { if (active) setPreview(makeSharingPreview(project, capsules.filter(c => selected.includes(c.id)))); }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [project, capsules, selected]);
  async function generate() { if (!preview || !selected.length || !handoffConsent || busy) return; setBusy(true); setError(''); setStatus('Sending only the previewed payload for cloud handoff…'); try { const { synthesizeHandoff } = await import('../ai/product-ai'); const result = await synthesizeHandoff(preview, true); setHandoff(result); setStatus('Cloud handoff returned. Review it before use.'); } catch (e) { setError(message(e)); setStatus(''); } finally { setBusy(false); } }
  async function queue() { if (!preview || !selected.length || !syncConsent || busy) return; setBusy(true); setError(''); try { await (await localStore()).enqueueSync(project.id, preview.capsules.map(c => c.id), true); setSyncConsent(false); setStatus('Approved payload saved in the local outbox. Nothing sent yet.'); await reload(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function sync() { if (busy || !online) return; setBusy(true); setError(''); setStatus("Syncing this project's approved outbox jobs…"); try { const { syncApprovedJobs } = await import('../sync/firebase-sync'); const result = await syncApprovedJobs(project.id); setStatus(`${result.synced} synced; ${result.failed} failed. Only this project's approved jobs were processed.`); } catch (e) { setError(message(e)); setStatus(''); } finally { await reload(); setBusy(false); } }
  async function checkReceipt(jobId: string) {
    if (busy || !online) return;
    setBusy(true); setError(''); setStatus('Reading this approval\'s server receipt only. No upload will be started.');
    try {
      const { checkApprovedJobReceipt } = await import('../sync/firebase-sync');
      const result = await checkApprovedJobReceipt(project.id, jobId);
      setStatus(result.status === 'verified'
        ? `Server receipt verified for approval ${jobId}. No upload or local job update was performed.`
        : `No server receipt found for approval ${jobId} at this check. Write outcome remains unknown. No upload was started.`);
    } catch { setError('Server receipt could not be checked. Write outcome remains unknown. No upload was started.'); setStatus(''); }
    finally { setBusy(false); }
  }
  function download() { if (!handoff) return; const url = URL.createObjectURL(new Blob([handoff.text], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `relaytrace-handoff-${project.id}.txt`; document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <div className="rt-sharing"><div className="rt-section-heading"><h2>Choose what leaves this device</h2><span className="rt-mono">EXPLICIT APPROVAL ONLY</span></div><p className="rt-muted">Photos and filenames never enter this payload. Original notes and selected capsule fields do: check for sensitive details before approving.</p>{!capsules.length ? <Empty title="Nothing to share yet.">Commit a human-confirmed capsule first.</Empty> : <div className="rt-share-layout"><div className="rt-panel"><h3>01 / Select records</h3>{capsules.map(c => <label className="rt-selection" key={c.id}><input disabled={busy} type="checkbox" checked={selected.includes(c.id)} onChange={e => setSelected(current => e.target.checked ? [...current, c.id] : current.filter(id => id !== c.id))} /><span><span className="rt-mono">{c.id.slice(0, 8)}</span><strong>{c.fields.observation[0] || 'Confirmed state capsule'}</strong><small>{date(c.createdAt)}</small></span></label>)}<p className="rt-fine">{selected.length} selected. No records are selected by default.</p></div><div className="rt-panel rt-preview"><div className="rt-section-heading"><h3>02 / Exact payload preview</h3><span className="rt-tag">JSON</span></div><pre aria-label="Exact sharing payload">{preview ? JSON.stringify(preview, null, 2) : 'Building local preview…'}</pre></div></div>}<div className="rt-approval-grid"><section className="rt-panel"><Cloud size={22} /><h3>Cloud handoff</h3><p>Send this preview to the cloud AI service to prepare a written handoff. This does not approve database sync.</p><label className="rt-consent"><input type="checkbox" disabled={busy || !selected.length} checked={handoffConsent} onChange={e => setHandoffConsent(e.target.checked)} /><span>I approve sending the exact preview above for cloud handoff generation.</span></label><button className="rt-primary" disabled={busy || !online || !preview || !selected.length || !handoffConsent} onClick={() => void generate()}><FileText size={16} /> Generate cloud handoff</button></section><section className="rt-panel"><ArrowRight size={22} /><h3>Approved sync</h3><p>Save an immutable approved payload to the local outbox. Sending is a separate, explicit action below.</p><label className="rt-consent"><input type="checkbox" disabled={busy || !selected.length} checked={syncConsent} onChange={e => setSyncConsent(e.target.checked)} /><span>I approve syncing the exact preview above to the configured cloud database.</span></label><button disabled={busy || !preview || !selected.length || !syncConsent} onClick={() => void queue()}>Approve & add to outbox</button></section></div>{!online && <p className="rt-status"><WifiOff size={16} /> Offline. Local approvals still work; cloud actions wait for your explicit retry.</p>}{error && <ErrorNotice>{error}</ErrorNotice>}{status && <p role="status" className="rt-status">{status}</p>}{handoff && <section className="rt-panel rt-handoff"><div className="rt-section-heading"><h2>Handoff draft</h2><span className="rt-tag">{handoff.source === 'in_cloud' ? 'Cloud SDK response' : handoff.source}</span></div><p className="rt-fine">AI-generated text. Review against the confirmed record before acting.</p><pre>{handoff.text}</pre><button onClick={download}><ArrowDownToLine size={16} /> Download handoff .txt</button></section>}<section className="rt-outbox"><div className="rt-section-heading"><h2>Local outbox <span className="rt-count">{jobs.length}</span></h2><button disabled={busy || !online || !jobs.some(j => j.status !== 'synced')} onClick={() => void sync()}>{busy ? 'Working…' : 'Sync / retry approved jobs'}</button></div><p className="rt-fine">Sync / retry sends only this project's previously approved pending or failed jobs. It never sends another project's jobs or unapproved selections.</p>{jobs.length === 0 ? <p className="rt-muted">No approved sync jobs for this project.</p> : <div className="rt-job-list">{jobs.map(job => <div className="rt-job" key={job.id}><div><span className="rt-mono">{job.id}</span><small>{job.payload.capsules.length} capsules · {job.attempts} attempts · approved {date(job.approvedAt)}</small><button disabled={busy || !online} onClick={() => void checkReceipt(job.id)}>Check server receipt (read only)</button>{job.error && <p className="rt-job-error">{job.error}</p>}<details><summary>View approved snapshot</summary><pre>{JSON.stringify(job.payload, null, 2)}</pre></details></div><span className={`rt-tag rt-job-${job.status}`}>{job.status}</span></div>)}</div>}</section></div>;
}
