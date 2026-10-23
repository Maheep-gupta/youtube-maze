// Livestream Setup card: validate a YouTube livestream URL, bind ONE account's workflow to it, or
// clear that account's selection. The card follows the Scheduler's account selector; switching
// accounts resets it. The server is authoritative for URL parsing and live/chat checks; this module only
// renders results. For streams on other channels, posting permission cannot be verified in advance
// and selecting one requires an explicit acknowledgement. Changing the stream is locked while the
// scheduler is active.
import { api } from './api.js';
import { el, clear, pill, errorBox, toast, toastError, withBusy, timeEl, field } from './ui.js';
import { onWorkflows, refreshStatus, workflowById, isActive } from './store.js';

const STATUS_PILLS = {
  unchecked: ['Not checked', 'grey'],
  valid: ['Valid', 'amber'],
  live: ['Live', 'green'],
  offline: ['Offline', 'amber'],
  error: ['Error', 'red'],
};

const ERROR_TITLES = {
  INVALID_STREAM_URL: 'Not a YouTube livestream link',
  STREAM_NOT_FOUND: 'Stream not found',
  STREAM_OFFLINE: 'Stream is offline',
  CHAT_UNAVAILABLE: 'Live chat unavailable',
  NO_CONNECTION: 'Choose a sending account',
  AUTH_FAILED: 'Reconnect your account',
  PERMISSION_DENIED: 'Posting not allowed',
  ACKNOWLEDGEMENT_REQUIRED: 'Confirm permission first',
  QUOTA_EXCEEDED: 'YouTube API quota used up',
  RATE_LIMITED: 'Too many requests',
  SCHEDULER_ACTIVE: 'Scheduler is running',
  STREAM_IN_USE: 'Stream already in use',
  CONCURRENT_EXTERNAL_BLOCKED: 'Concurrent workflow not allowed',
  NOT_FOUND: 'Account not found',
  NETWORK: 'Could not reach YouTube',
};

/**
 * Error box with a plain-language title. Raw upstream text ("YouTube API error (HTTP …)") is
 * shown only as a small details line; the hint explains what to do instead.
 */
function streamErrorBox(err) {
  const message = err?.message || String(err);
  const raw = /^YouTube API error/.test(message);
  const title = ERROR_TITLES[err?.code];
  if (!title) return errorBox(err);
  return el('div', { class: 'error-box', attrs: { role: 'alert' } },
    el('strong', { text: title }),
    el('div', { class: 'hint', text: raw ? (err.hint || message) : message }),
    !raw && err.hint && err.hint !== message ? el('div', { class: 'hint muted', text: err.hint }) : null,
    el('div', { class: 'muted small', text: raw ? `Details: ${message} · Code: ${err.code}` : `Code: ${err.code}` }));
}

let refs;
let getAccountId = () => null;
let accountId = null; // account the card currently shows
let selection = null;
let lastValidation = null; // { url, result } for the URL currently in the input
let locked = false;
let busy = false;
let userEdited = false; // never overwrite what the user typed with the (async) saved selection

/**
 * Build the card. `opts.getAccountId` returns the account (connection id) selected in the Scheduler.
 * @returns {HTMLElement}
 */
export function buildStreamSetup(opts = {}) {
  if (typeof opts.getAccountId === 'function') getAccountId = opts.getAccountId;
  const input = el('input', {
    type: 'url', name: 'streamUrl', autocomplete: 'off', spellcheck: false, maxLength: 2048,
    placeholder: 'https://www.youtube.com/watch?v=… · https://youtu.be/… · https://www.youtube.com/live/…',
  });
  refs = {
    input,
    statusPill: el('span', { attrs: { 'aria-live': 'polite' } }),
    result: el('div', { attrs: { 'aria-live': 'polite' } }),
    saved: el('div', { class: 'stream-saved' }),
    lockNote: el('p', { class: 'note stream-lock-note', text: 'Stop the scheduler to change streams.', hidden: true }),
    noAccount: el('p', { class: 'stream-warning small', hidden: true, text: 'Add an account under Accounts before selecting a livestream.' }),
    validate: el('button', { type: 'submit', class: 'btn', text: 'Validate Stream' }),
    connect: el('button', { type: 'button', class: 'btn btn-primary', text: 'Connect to Stream', disabled: true }),
    clearBtn: el('button', { type: 'button', class: 'btn btn-danger', text: 'Clear selection', disabled: true }),
    ackBox: el('input', { type: 'checkbox', name: 'acknowledgeExternal' }),
    ack: null,
  };
  refs.ack = el('label', { class: 'check stream-ack', hidden: true },
    refs.ackBox,
    el('span', { text: "I have the stream owner's permission to post automated messages in this chat, and I'm responsible for following YouTube's rules." }));
  refs.ackBox.addEventListener('change', syncControls);

  input.addEventListener('input', () => {
    userEdited = true;
    lastValidation = null;
    setPill('unchecked');
    refs.result.replaceChildren();
    resetAck();
    syncControls();
  });

  const form = el('form', { class: 'stack', attrs: { novalidate: true } },
    field('YouTube livestream URL', input, { help: "Any YouTube livestream. Whether you can post depends on that chat's rules. Accepted: watch?v=, youtu.be/, /live/ links." }),
    refs.ack,
    el('div', { class: 'btn-row' }, refs.validate, refs.connect, refs.clearBtn));
  form.addEventListener('submit', (e) => { e.preventDefault(); validate(); });
  refs.connect.addEventListener('click', connect);
  refs.clearBtn.addEventListener('click', clearSelection);

  setPill('unchecked');
  onWorkflows(() => syncAccount());

  return el('section', { class: 'card card-accent stream-setup', attrs: { 'aria-labelledby': 'stream-setup-title' } },
    el('div', { class: 'card-title-row' },
      el('h2', { class: 'card-title', id: 'stream-setup-title', text: 'Livestream Setup' }),
      refs.statusPill),
    refs.noAccount,
    form,
    refs.result,
    refs.lockNote,
    refs.saved);
}

/** Follow the Scheduler's account: reset the card on a switch, else refresh selection and lock. */
function syncAccount() {
  const id = getAccountId() || null;
  const w = workflowById(id);
  if (id !== accountId) {
    accountId = id;
    resetCard();
    setSelection(w ? (w.selection ?? w.status?.stream ?? null) : null, { prefill: true });
  } else if (w) {
    setSelection(w.selection ?? w.status?.stream ?? null, { prefill: false });
  }
  refs.noAccount.hidden = Boolean(w);
  setLocked(!w || isActive(w.status) || Boolean(w.status?.locked));
}

function resetCard() {
  refs.input.value = '';
  userEdited = false;
  lastValidation = null;
  selection = null;
  resetAck();
  setPill('unchecked');
  refs.result.replaceChildren();
  renderSaved();
}

const base = (id) => `/api/workflows/${encodeURIComponent(id)}`;

function setPill(kind) {
  const [label, tone] = STATUS_PILLS[kind] || STATUS_PILLS.unchecked;
  const p = pill(label, tone);
  p.dataset.streamStatus = kind;
  refs.statusPill.replaceChildren(p);
}

function setLocked(v) {
  locked = Boolean(v);
  refs.lockNote.hidden = !locked || !workflowById(accountId);
  syncControls();
}

const needsAck = (r) => Boolean(r && (r.requiresAcknowledgement || (r.external && !r.owned)));

function resetAck() {
  refs.ackBox.checked = false;
  refs.ack.hidden = true;
}

function syncControls() {
  const current = refs.input.value.trim();
  const r = lastValidation && lastValidation.url === current ? lastValidation.result : null;
  const canConnect = Boolean(r?.canConnect && (!needsAck(r) || refs.ackBox.checked));
  refs.ackBox.disabled = locked || busy;
  refs.input.disabled = locked;
  refs.validate.disabled = locked || busy || !current;
  refs.connect.disabled = locked || busy || !canConnect;
  refs.clearBtn.disabled = locked || busy || !selection;
}

function kv(label, value) {
  return [el('dt', { text: label }), el('dd', {}, value ?? '—')];
}

function setSelection(sel, { prefill = true } = {}) {
  const changed = (sel?.videoId ?? null) !== (selection?.videoId ?? null) || (sel?.validatedAt ?? null) !== (selection?.validatedAt ?? null);
  selection = sel || null;
  const interacting = userEdited || document.activeElement === refs.input;
  if (prefill && !interacting && selection?.url && !refs.input.value.trim()) refs.input.value = selection.url;
  if (changed || prefill) renderSaved();
  syncControls();
}

function renderSaved() {
  if (!selection) {
    clear(refs.saved, el('p', { class: 'muted small', text: 'No livestream selected. The scheduler cannot start until you connect to one.' }));
    return;
  }
  clear(refs.saved,
    el('h3', { class: 'field-label', text: 'Selected stream' }),
    el('dl', { class: 'kv' },
      kv('Title', selection.title || 'Untitled stream'),
      kv('Channel', channelWithBadge(selection.channelTitle, Boolean(selection.external))),
      kv('Video ID', el('code', { text: selection.videoId })),
      kv('URL', el('span', { class: 'break-all', text: selection.url || '—' })),
      kv('Validated', selection.validatedAt ? timeEl(selection.validatedAt) : '—'),
      selection.external && selection.acknowledgedAt ? kv('Permission confirmed', timeEl(selection.acknowledgedAt)) : null));
}

/** Channel name followed by a "Your channel" / "External channel" badge. */
export function channelWithBadge(channelTitle, external) {
  return el('span', {},
    channelTitle || '—', ' ',
    pill(external ? 'External channel' : 'Your channel', external ? 'amber' : 'green'));
}

function chatLine(r) {
  if (!r.chatAvailable) return r.chatReason || 'Not available';
  if (r.owned) return 'Active';
  return r.chatReadable === true ? 'Active — readable by this account' : 'Active';
}

function postingLine(r) {
  if (r.owned || r.postingPermission === 'owner') return 'Allowed (you own this stream)';
  return 'Not verifiable in advance — confirmed only when YouTube accepts the first message';
}

function renderResult(r) {
  const kind = r.status === 'live' && r.chatAvailable ? 'live' : r.status === 'live' ? 'error' : (r.status === 'valid' ? 'valid' : 'offline');
  setPill(kind);
  const msgTone = r.canConnect ? 'muted small' : 'stream-warning small';
  const external = Boolean(r.external || r.owned === false);
  clear(refs.result,
    el('dl', { class: 'kv' },
      kv('Title', r.title || '—'),
      kv('Channel', channelWithBadge(r.channelTitle, external)),
      kv('Status', STATUS_PILLS[kind][0]),
      kv('Video ID', el('code', { text: r.videoId || '—' })),
      kv('Live chat', chatLine(r)),
      kv('Posting', el('span', { class: external ? 'stream-warning' : '', text: postingLine(r) }))),
    r.message ? el('p', { class: msgTone, text: r.message }) : null);
  refs.ackBox.checked = false;
  refs.ack.hidden = !(r.canConnect && needsAck(r));
}

function body(url, { acknowledge = false } = {}) {
  return acknowledge ? { url, acknowledgeExternal: true } : { url };
}

async function validate() {
  const url = refs.input.value.trim();
  const id = accountId;
  if (!url || locked || !id) return;
  busy = true;
  refs.result.replaceChildren();
  try {
    const r = await withBusy(refs.validate, () => api.post(`${base(id)}/stream/validate`, body(url)));
    if (id !== accountId) return; // account switched meanwhile
    lastValidation = { url, result: r };
    renderResult(r);
  } catch (err) {
    if (id !== accountId) return;
    lastValidation = null;
    resetAck();
    setPill('error');
    clear(refs.result, streamErrorBox(err));
  } finally {
    busy = false;
    syncControls();
  }
}

async function connect() {
  const url = refs.input.value.trim();
  const id = accountId;
  if (!url || locked || !id) return;
  busy = true;
  try {
    const acknowledge = needsAck(lastValidation?.result) && refs.ackBox.checked;
    const r = await withBusy(refs.connect, () => api.post(`${base(id)}/stream/select`, body(url, { acknowledge })));
    if (id !== accountId) { refreshStatus(); return; }
    if (r?.validation) { lastValidation = { url, result: r.validation }; renderResult(r.validation); }
    setSelection(r?.selection ?? null, { prefill: false });
    renderSaved();
    toast(`Scheduler bound to "${r?.selection?.title || r?.selection?.videoId || 'stream'}".`, { tone: 'success' });
    refreshStatus();
  } catch (err) {
    if (id !== accountId) return;
    setPill('error');
    clear(refs.result, streamErrorBox(err));
    if (err.code === 'SCHEDULER_ACTIVE') refreshStatus();
  } finally {
    busy = false;
    syncControls();
  }
}

async function clearSelection() {
  const id = accountId;
  if (locked || !selection || !id) return;
  busy = true;
  const before = refs.input.value;
  try {
    await withBusy(refs.clearBtn, () => api.del(`${base(id)}/stream`));
    if (id !== accountId) { refreshStatus(); return; }
    setSelection(null, { prefill: false });
    renderSaved();
    // Don't wipe a URL the user started typing while the request was in flight.
    if (refs.input.value === before) {
      refs.input.value = '';
      lastValidation = null;
      resetAck();
      setPill('unchecked');
      refs.result.replaceChildren();
    }
    toast('Stream selection cleared.', { tone: 'success' });
    refreshStatus();
  } catch (err) {
    toastError(err, 'Could not clear stream selection');
  } finally {
    busy = false;
    syncControls();
  }
}

/** Load the selected account's saved selection (called when the Scheduler view is shown). */
export async function loadStreamSetup() {
  if (!refs) return;
  const id = getAccountId();
  if (!id) { syncAccount(); return; }
  try {
    const w = await api.get(base(id));
    if (id !== accountId) { syncAccount(); return; }
    setSelection(w?.selection ?? w?.status?.stream ?? null, { prefill: true });
    setLocked(isActive(w?.status) || Boolean(w?.status?.locked));
  } catch (err) {
    clear(refs.saved, streamErrorBox(err));
  }
}

/** One-line summary of the selected stream for status cards. */
export function streamSummary(stream) {
  if (!stream) return null;
  return el('span', { class: 'stream-summary' },
    el('strong', { text: stream.title || 'Untitled stream' }),
    ' ',
    el('code', { class: 'muted', text: stream.videoId }),
    stream.external ? pill('External', 'amber') : null);
}
