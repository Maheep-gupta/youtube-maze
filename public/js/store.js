// Shared client state: the latest workflows (one per account, polled by main.js), the account
// selected in the Scheduler view, the test-mode flag, and the workflow control actions used by
// the Overview and Scheduler sections. Every action names its account explicitly.
import { api } from './api.js';
import { el, toastError, toast, withBusy, STATE_TONES, pill, formatCountdown } from './ui.js';
import { askExternalTerms } from './termsDialog.js';

const listeners = new Set();
const tickListeners = new Set();
const SELECTED_KEY = 'lcc.selectedAccount'; // only an opaque connection id, never anything sensitive

export const store = {
  workflows: [],
  policy: null,
  receivedAt: 0,
  loaded: false,
  appTestMode: false,
  statusError: null,
  selectedId: readSelected(),
};

function readSelected() {
  try { return localStorage.getItem(SELECTED_KEY) || null; } catch { return null; }
}

/** Subscribe to workflow updates: fn(workflows, err). */
export function onWorkflows(fn) { listeners.add(fn); if (store.loaded) fn(store.workflows); return () => listeners.delete(fn); }
export function onTick(fn) { tickListeners.add(fn); return () => tickListeners.delete(fn); }

function emit(err) {
  for (const fn of listeners) { try { fn(store.workflows, err); } catch (e) { console.error(e); } }
}

export function workflowById(id) {
  return id ? store.workflows.find((w) => w.connectionId === id) ?? null : null;
}

/** The account shown in the Scheduler view: the remembered one if it still exists, else the first. */
export function selectedWorkflow() {
  return workflowById(store.selectedId) ?? store.workflows[0] ?? null;
}

export function selectAccount(id) {
  store.selectedId = id || null;
  try { if (id) localStorage.setItem(SELECTED_KEY, id); else localStorage.removeItem(SELECTED_KEY); } catch { /* storage unavailable */ }
  emit();
}

export function setWorkflows(data) {
  store.workflows = Array.isArray(data?.items) ? data.items : [];
  store.policy = data?.policy ?? null;
  store.receivedAt = Date.now();
  store.loaded = true;
  store.statusError = null;
  updateTestBanner();
  emit();
}

/** Replace one workflow's status after an action (the next poll refreshes everything anyway). */
function mergeStatus(id, status) {
  const w = workflowById(id);
  if (!w || !status || typeof status.state !== 'string') return;
  w.status = status;
  store.receivedAt = Date.now();
  emit();
}

export function setAppTestMode(v) {
  store.appTestMode = Boolean(v);
  updateTestBanner();
}

export function isTestMode() {
  return store.appTestMode || store.workflows.some((w) => w.status?.isTestMode && w.status?.state !== 'idle');
}

export function updateTestBanner() {
  const banner = document.getElementById('test-banner');
  if (banner) banner.hidden = !isTestMode();
}

export async function refreshStatus() {
  try {
    const data = await api.get('/api/workflows');
    setWorkflows(data);
    return data;
  } catch (err) {
    store.statusError = err;
    emit(err);
    return null;
  }
}

export function fireTick() {
  for (const fn of tickListeners) { try { fn(); } catch (e) { console.error(e); } }
}

export const isActive = (status) => status?.state === 'running' || status?.state === 'paused';

/** Milliseconds until a workflow's next send, corrected for time since the poll arrived. */
export function msUntilNext(status) {
  if (!status || status.state !== 'running') return null;
  if (Number.isFinite(status.msUntilNext)) return Math.max(0, status.msUntilNext - (Date.now() - store.receivedAt));
  if (status.nextRunAt) return Math.max(0, new Date(status.nextRunAt).getTime() - Date.now());
  return null;
}

export function countdownText(status) {
  if (!status) return '--:--';
  if (status.state === 'paused') return 'Paused';
  if (status.state !== 'running') return '--:--';
  if (status.inFlight) return 'Sending…';
  return formatCountdown(msUntilNext(status));
}

export function statePill(state) {
  const s = state || 'unknown';
  return pill(s.charAt(0).toUpperCase() + s.slice(1), STATE_TONES[s] || 'grey');
}

/** "2 running" / "1 running · 1 paused" / "Idle" across all accounts. */
export function aggregateText(workflows = store.workflows) {
  const running = workflows.filter((w) => w.status?.state === 'running').length;
  const paused = workflows.filter((w) => w.status?.state === 'paused').length;
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (paused) parts.push(`${paused} paused`);
  return parts.length ? parts.join(' · ') : 'Idle';
}

export function aggregatePill(workflows = store.workflows) {
  const running = workflows.some((w) => w.status?.state === 'running');
  const paused = workflows.some((w) => w.status?.state === 'paused');
  return pill(aggregateText(workflows), running ? 'green' : paused ? 'amber' : 'grey');
}

// ---------- workflow actions ----------

const PAST = { start: 'started', pause: 'paused', resume: 'resumed', stop: 'stopped' };

/**
 * Run start/pause/resume/stop for ONE account. Errors (e.g. STREAM_IN_USE,
 * CONCURRENT_EXTERNAL_BLOCKED) are shown in `errorTarget` and as a toast.
 */
export async function runAction(connectionId, name, button, errorTarget, { termsAsked = false } = {}) {
  if (errorTarget) errorTarget.replaceChildren();
  if (!connectionId) return;
  const w = workflowById(connectionId);
  const label = w?.label || 'account';
  try {
    const r = await withBusy(button, () => api.post(`/api/workflows/${encodeURIComponent(connectionId)}/${name}`, {}));
    mergeStatus(connectionId, r?.status ?? r);
    toast(`Scheduler ${PAST[name]} for "${label}".`, { tone: 'success' });
  } catch (err) {
    // External livestream without a current acceptance: show the terms, then try once more if accepted.
    if (err.code === 'TERMS_ACCEPTANCE_REQUIRED' && !termsAsked && (name === 'start' || name === 'resume')) {
      const videoId = err.details?.videoId || w?.selection?.videoId;
      let decision;
      try {
        decision = await askExternalTerms({ connectionId, videoId, accountLabel: label, streamLabel: w?.selection?.title });
      } catch (dialogErr) {
        toastError(dialogErr, 'Could not load the terms');
      }
      if (decision === 'accepted') return runAction(connectionId, name, button, errorTarget, { termsAsked: true });
      if (decision === 'declined') toast('Terms declined. The scheduler was not started.', { tone: 'info' });
    }
    toastError(err, `Could not ${name} "${label}"`);
    if (errorTarget) {
      errorTarget.append(el('div', { class: 'error-box', attrs: { role: 'alert' } },
        el('strong', { text: err.message }),
        err.hint ? el('div', { class: 'hint', text: err.hint }) : null,
        err.code ? el('div', { class: 'muted small', text: `Code: ${err.code}` }) : null));
    }
  }
  refreshStatus();
}

/** Show/enable controls for a workflow state. */
function syncButtons({ start, pause, resume, stop }, state) {
  start.disabled = state !== 'idle';
  pause.disabled = state !== 'running';
  resume.disabled = state !== 'paused';
  stop.disabled = !(state === 'running' || state === 'paused');
  pause.hidden = state === 'paused';
  resume.hidden = state !== 'paused';
}

/**
 * Start/Pause/Resume/Stop controls for the account returned by `getId()` (re-read on every
 * update, so one control set can follow the Scheduler's account selector). Returns the element.
 */
export function schedulerControls({ large = false, getId } = {}) {
  const errorTarget = el('div', { class: 'control-errors' });
  const mk = (name, label, cls) => {
    const b = el('button', { type: 'button', class: `btn ${cls}${large ? ' btn-lg' : ''}`, text: label, disabled: true });
    b.addEventListener('click', () => runAction(getId?.(), name, b, errorTarget));
    return b;
  };
  const buttons = { start: mk('start', 'Start', 'btn-primary'), pause: mk('pause', 'Pause', ''), resume: mk('resume', 'Resume', 'btn-primary'), stop: mk('stop', 'Stop', 'btn-danger') };
  const wrap = el('div', { class: 'controls' }, el('div', { class: 'btn-row' }, buttons.start, buttons.pause, buttons.resume, buttons.stop), errorTarget);
  let lastId;
  onWorkflows(() => {
    const id = getId?.();
    if (id !== lastId) { errorTarget.replaceChildren(); lastId = id; }
    if (Object.values(buttons).some((b) => b.getAttribute('aria-busy'))) return;
    const w = workflowById(id);
    if (!w) { for (const b of Object.values(buttons)) b.disabled = true; return; }
    syncButtons(buttons, w.status?.state);
  });
  return wrap;
}
