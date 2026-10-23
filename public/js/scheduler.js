// Scheduler view, scoped to ONE account at a time (the "Account" selector). Each account has its
// own workflow: settings, selected livestream, session, controls and review queue.
import { api } from './api.js';
import { el, clear, field, errorBox, toast, withBusy, CATEGORIES, categoryLabel, shortId, timeEl, pill, CONNECTION_TONES, $, $$ } from './ui.js';
import { onWorkflows, onTick, countdownText, statePill, schedulerControls, refreshStatus, selectedWorkflow, selectAccount, workflowById, isActive, store } from './store.js';
import { buildStreamSetup, loadStreamSetup, streamSummary } from './streamSetup.js';

let refs;
let visible = false;
let formAccount; // account whose settings are currently in the form

const currentId = () => selectedWorkflow()?.connectionId ?? null;
const base = (id) => `/api/workflows/${encodeURIComponent(id)}`;

export function init(container) {
  refs = {
    statePill: el('span'),
    countdown: el('div', { class: 'countdown countdown-xl', text: '--:--' }),
    statusGrid: el('dl', { class: 'kv kv-grid' }),
    statusNote: el('div'),
    streamBanner: el('div', { class: 'stream-banner', attrs: { 'aria-live': 'polite' } }),
    startHint: el('p', { class: 'stream-warning small', hidden: true, text: 'Select a livestream in Livestream Setup before starting.' }),
    review: el('div', { class: 'review-panel', hidden: true, attrs: { 'aria-live': 'polite' } }),
    reviewKey: null,
    formErrors: el('div'),
    form: null,
    inputs: {},
    account: el('select', { name: 'account' }),
    accountMeta: el('span', { class: 'account-meta' }),
    empty: el('p', { class: 'empty', hidden: true }, 'No accounts yet. ', el('a', { href: '#connections', class: 'link', text: 'Add an account under Accounts →' })),
  };
  refs.account.addEventListener('change', () => selectAccount(refs.account.value));
  const controls = schedulerControls({ large: true, getId: currentId });

  clear(container,
    el('header', { class: 'view-header' }, el('h1', { text: 'Scheduler' })),
    el('section', { class: 'card account-bar' },
      el('div', { class: 'account-bar-row' },
        field('Account', refs.account),
        refs.accountMeta),
      el('p', { class: 'note', text: "Several accounts can run at once only when each posts to its own channel's stream." }),
      refs.empty),
    buildStreamSetup({ getAccountId: currentId }),
    el('div', { class: 'grid grid-2' },
      el('section', { class: 'card card-accent' },
        el('div', { class: 'card-title-row' }, el('h2', { class: 'card-title', text: 'Live status' }), refs.statePill),
        refs.streamBanner,
        el('div', { class: 'countdown-label muted small', text: 'Next message in' }),
        refs.countdown,
        controls,
        refs.startHint,
        refs.review,
        refs.statusGrid,
        refs.statusNote,
        el('p', { class: 'note', text: 'Posts only to the selected livestream and never switches to another broadcast. Stream and chat are re-checked before every send.' })),
      el('section', { class: 'card' },
        el('h2', { class: 'card-title', text: 'Settings' }),
        buildForm())));

  onWorkflows(renderWorkflows);
  onTick(() => { if (visible) refs.countdown.textContent = countdownText(selectedWorkflow()?.status); });
}

function renderWorkflows(items) {
  if (!refs) return;
  const w = selectedWorkflow();
  // Account selector: one option per account (label only; ids stay internal).
  const ids = items.map((x) => `${x.connectionId}:${x.label}`).join('|');
  if (refs.account.dataset.ids !== ids) {
    refs.account.dataset.ids = ids;
    refs.account.replaceChildren(...(items.length
      ? items.map((x) => el('option', { value: x.connectionId, text: x.label || shortId(x.connectionId) }))
      : [el('option', { value: '', text: 'No accounts' })]));
  }
  refs.account.value = w?.connectionId ?? '';
  refs.account.disabled = !items.length;
  refs.empty.hidden = items.length > 0;
  clear(refs.accountMeta, w
    ? [pill(w.connectionStatus || 'unknown', CONNECTION_TONES[w.connectionStatus] || 'grey'), ' ', el('span', { class: 'muted small', text: w.provider || '' })]
    : null);
  renderStatus(w?.status ?? null);
  if (w && w.connectionId !== formAccount && visible) {
    formAccount = w.connectionId;
    clearErrors();
    fillForm(w.settings);
  }
}

function kv(label, value) {
  return [el('dt', { text: label }), el('dd', {}, value ?? '—')];
}

function renderStatus(status) {
  if (!refs) return;
  if (!status) {
    refs.statePill.replaceChildren();
    refs.countdown.textContent = '--:--';
    refs.streamBanner.replaceChildren();
    refs.statusGrid.replaceChildren();
    refs.statusNote.replaceChildren();
    refs.startHint.hidden = true;
    renderReview(null);
    return;
  }
  refs.statePill.replaceChildren(statePill(status.state));
  refs.countdown.textContent = countdownText(status);
  const s = status.session;
  const t = status.today || {};
  const active = isActive(status);
  const stream = status.stream ?? selectedWorkflow()?.selection ?? null;
  clear(refs.streamBanner, stream
    ? el('p', { class: active ? 'stream-banner-active' : 'muted small' }, active ? 'Streaming to: ' : 'Selected stream: ', streamSummary(stream))
    : el('p', { class: 'muted small', text: 'No livestream selected.' }));
  refs.startHint.hidden = !(status.state === 'idle' && !stream);
  renderReview(active ? status.pendingReview ?? null : null);
  clear(refs.statusGrid,
    kv('State', status.state),
    kv('Session', s ? el('code', { text: shortId(s.id), attrs: { title: s.id } }) : '—'),
    kv('Broadcast', s?.broadcastTitle || (status.state === 'idle' ? 'not live' : '—')),
    kv('Sent this session', String(s?.messagesSent ?? 0)),
    kv('Failed this session', String(s?.messagesFailed ?? 0)),
    kv('Sent today', `${t.sent ?? 0}${t.limit ? ` / ${t.limit}` : ' (no daily limit)'}`),
    kv('Provider', status.provider || '—'),
    s?.startedAt ? kv('Started', timeEl(s.startedAt)) : null);
  clear(refs.statusNote, status.state === 'idle' && s?.stopReason
    ? el('p', { class: 'muted small', text: `Last session ended: ${s.stopReason}` }) : null);
}

/** Manual review: the picked message waits here until approved (posted) or skipped. */
function renderReview(pending) {
  const id = currentId();
  const key = pending ? `${id}:${pending.messageId}:${pending.proposedAt}` : null;
  if (key === refs.reviewKey) return; // don't rebuild on every poll (keeps focus and busy state)
  refs.reviewKey = key;
  refs.review.hidden = !pending;
  if (!pending) { refs.review.replaceChildren(); return; }
  const errors = el('div');
  const approve = el('button', { type: 'button', class: 'btn btn-primary', text: 'Approve & send' });
  const skip = el('button', { type: 'button', class: 'btn', text: 'Skip' });
  const act = async (btn, path, onOk) => {
    errors.replaceChildren();
    approve.disabled = true; skip.disabled = true;
    try {
      const r = await withBusy(btn, () => api.post(path, {}));
      onOk(r);
      refs.reviewKey = undefined; // force a re-render (null would mean "no pending message")
      refreshStatus();
    } catch (err) {
      clear(errors, errorBox(err));
      approve.disabled = false; skip.disabled = false;
    }
  };
  approve.addEventListener('click', () => act(approve, `${base(id)}/review/approve`, (r) => {
    if (r?.result?.sent) toast('Message sent — the provider confirmed it.', { tone: 'success' });
    else toast(`Message not sent: ${r?.result?.message || r?.result?.failed || 'unknown error'}`, { tone: 'error' });
  }));
  skip.addEventListener('click', () => act(skip, `${base(id)}/review/reject`, () => toast('Message skipped.', { tone: 'info' })));
  clear(refs.review,
    el('h3', { class: 'field-label', text: 'Message awaiting your approval' }),
    el('blockquote', { class: 'review-text', text: pending.text }),
    el('p', { class: 'muted small' },
      categoryLabel(pending.category), ' · proposed ', pending.proposedAt ? timeEl(pending.proposedAt) : '—'),
    el('div', { class: 'btn-row' }, approve, skip),
    errors);
}

function numberInput(name, { min, max, required = true, placeholder } = {}) {
  const i = el('input', { type: 'number', name, min, max, step: 1, required, placeholder, attrs: { inputmode: 'numeric' } });
  refs.inputs[name] = i;
  return i;
}

function buildForm() {
  const interval = numberInput('intervalSeconds', { min: 30, max: 3600 });
  const intervalHelp = el('span', { class: 'field-help' });
  const updateHelp = () => {
    const v = Number(interval.value);
    intervalHelp.textContent = Number.isFinite(v) && v > 0 ? `≈ ${(v / 60).toFixed(v % 60 ? 1 : 0)} minute${v === 60 ? '' : 's'} between messages (30–3600 s)` : '30–3600 seconds';
  };
  interval.addEventListener('input', updateHelp);

  const categories = el('fieldset', { class: 'checkbox-grid' },
    el('legend', { class: 'field-label', text: 'Categories' }),
    CATEGORIES.map((c) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', name: 'categories', value: c }), el('span', { text: categoryLabel(c) }))),
    el('span', { class: 'field-help', text: 'None selected = all categories.' }),
    el('span', { class: 'field-error', dataset: { errorFor: 'categories' } }));

  const reviewMode = el('input', { type: 'checkbox', name: 'reviewMode' });
  refs.inputs.reviewMode = reviewMode;
  const reviewField = el('div', { class: 'field' },
    el('label', { class: 'check' }, reviewMode, el('span', { text: 'Manual review' })),
    el('span', { class: 'field-help', text: 'Each picked message waits for your approval before it is posted.' }),
    el('span', { class: 'field-error', dataset: { errorFor: 'reviewMode' } }));

  const intervalField = field('Interval (seconds)', interval, { errorKey: 'intervalSeconds' });
  intervalField.insertBefore(intervalHelp, intervalField.querySelector('.field-error'));

  const save = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save settings' });
  const form = el('form', { class: 'stack', attrs: { novalidate: true } },
    el('div', { class: 'form-grid' },
      intervalField,
      field('Minimum delay (seconds)', numberInput('minDelaySeconds', { min: 10, max: 3600 }), { help: 'Minimum gap after a successful send (≤ interval).', errorKey: 'minDelaySeconds' }),
      field('Max messages per session', numberInput('maxMessagesPerSession', { min: 1, max: 500 }), { help: '1–500', errorKey: 'maxMessagesPerSession' }),
      field('Daily limit', numberInput('dailyLimit', { min: 1, max: 2000, required: false, placeholder: 'No limit' }), { help: 'Leave empty for no daily limit (1–2000).', errorKey: 'dailyLimit' }),
      field('Max consecutive failures', numberInput('maxConsecutiveFailures', { min: 1, max: 10 }), { help: 'Stops the session after this many failures in a row (1–10).', errorKey: 'maxConsecutiveFailures' })),
    categories,
    reviewField,
    refs.formErrors,
    el('div', { class: 'btn-row' }, save));
  refs.form = form;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    const body = readForm();
    const id = currentId();
    if (!body || !id) return;
    try {
      const r = await withBusy(save, () => api.put(`${base(id)}/settings`, body));
      if (id === currentId()) fillForm(r?.settings ?? r);
      toast(`Scheduler settings saved for "${workflowById(id)?.label || 'account'}". They apply from the next tick.`, { tone: 'success' });
      refreshStatus();
    } catch (err) {
      showErrors(err);
    }
  });
  updateHelp();
  return form;
}

function readForm() {
  const n = (name) => {
    const raw = refs.inputs[name].value.trim();
    return raw === '' ? null : Number(raw);
  };
  const body = {
    intervalSeconds: n('intervalSeconds'),
    minDelaySeconds: n('minDelaySeconds'),
    maxMessagesPerSession: n('maxMessagesPerSession'),
    dailyLimit: n('dailyLimit'),
    maxConsecutiveFailures: n('maxConsecutiveFailures'),
    categories: $$('input[name="categories"]:checked', refs.form).map((i) => i.value),
    reviewMode: refs.inputs.reviewMode.checked,
  };
  const errs = [];
  for (const k of ['intervalSeconds', 'minDelaySeconds', 'maxMessagesPerSession', 'maxConsecutiveFailures']) {
    if (body[k] === null || !Number.isInteger(body[k])) errs.push({ path: k, message: 'Enter a whole number.' });
  }
  if (body.dailyLimit !== null && !Number.isInteger(body.dailyLimit)) errs.push({ path: 'dailyLimit', message: 'Enter a whole number or leave empty.' });
  if (Number.isInteger(body.minDelaySeconds) && Number.isInteger(body.intervalSeconds) && body.minDelaySeconds > body.intervalSeconds) {
    errs.push({ path: 'minDelaySeconds', message: 'Minimum delay cannot exceed the interval.' });
  }
  if (errs.length) { showErrors({ message: 'Please fix the highlighted fields.', details: errs }); return null; }
  return body;
}

function clearErrors() {
  refs.formErrors.replaceChildren();
  for (const e of refs.form.querySelectorAll('[data-error-for]')) e.textContent = '';
  for (const i of refs.form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
}

function showErrors(err) {
  const unmatched = [];
  for (const d of err.details || []) {
    const key = String(d.path ?? '').split('.')[0];
    const target = key && refs.form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
    if (target) {
      target.textContent = d.message;
      refs.inputs[key]?.setAttribute('aria-invalid', 'true');
    } else unmatched.push(d);
  }
  refs.formErrors.append(errorBox(err));
  if (unmatched.length) refs.formErrors.append(el('ul', { class: 'plain-list small' }, unmatched.map((d) => el('li', { text: `${d.path || 'settings'}: ${d.message}` }))));
}

function fillForm(s) {
  if (!s) return;
  for (const k of ['intervalSeconds', 'minDelaySeconds', 'maxMessagesPerSession', 'maxConsecutiveFailures']) refs.inputs[k].value = s[k] ?? '';
  refs.inputs.dailyLimit.value = s.dailyLimit ?? '';
  const cats = new Set(s.categories || []);
  for (const i of $$('input[name="categories"]', refs.form)) i.checked = cats.has(i.value);
  refs.inputs.reviewMode.checked = Boolean(s.reviewMode);
  refs.inputs.intervalSeconds.dispatchEvent(new Event('input'));
}

export async function show() {
  visible = true;
  clearErrors();
  formAccount = undefined;
  await refreshStatus();
  renderWorkflows(store.workflows);
  await loadStreamSetup();
}

export function hide() { visible = false; }
