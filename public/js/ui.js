// Shared DOM helpers. Everything renders text via textContent; never innerHTML with data.

export const CATEGORY_LABELS = Object.freeze({
  compliments: 'Compliments',
  sarcasm: 'Sarcasm',
  witty_jokes: 'Witty jokes',
  motivation: 'Motivation',
  wholesome: 'Wholesome',
});
export const CATEGORIES = Object.freeze(Object.keys(CATEGORY_LABELS));
export const MAX_MESSAGE_LENGTH = 200;

export const categoryLabel = (c) => CATEGORY_LABELS[c] || c || '—';

/**
 * Create an element. `props` keys: class, text, attrs (object), dataset, on (event map),
 * or any DOM property (value, checked, disabled, type, id, htmlFor, ...).
 * Children may be nodes, strings (as text) or falsy (skipped).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av !== undefined && av !== null && av !== false) node.setAttribute(a, av === true ? '' : String(av)); }
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style' || k.startsWith('on')) throw new Error(`el(): use classes / on map instead of "${k}"`);
    else node[k] = v;
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export function pill(label, tone = 'grey') {
  return el('span', { class: `pill pill-${tone}`, text: label });
}

export const STATE_TONES = { running: 'green', paused: 'amber', idle: 'grey' };
export const LEVEL_TONES = { success: 'green', info: 'grey', warning: 'amber', error: 'red' };
export const CONNECTION_TONES = { connected: 'green', disconnected: 'grey', error: 'red' };

// ---------- graphemes ----------
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function graphemeLength(text) {
  const s = String(text ?? '');
  if (!segmenter) return [...s].length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

// ---------- time formatting ----------
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const rtf = typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dtf.format(d);
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (!rtf) return formatTime(iso);
  if (abs < 45) return rtf.format(diff, 'second');
  if (abs < 2700) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 64800) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/** A <time> element with absolute title and relative text. */
export function timeEl(iso) {
  return el('time', { attrs: { datetime: iso || undefined, title: iso ? formatTime(iso) : undefined }, text: relativeTime(iso) });
}

export function formatCountdown(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function shortId(id) {
  return id ? String(id).slice(0, 8) : '—';
}

export function debounce(fn, ms = 300) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---------- toasts ----------
export function toast(message, { tone = 'info', hint, timeout = 5000 } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const close = el('button', { type: 'button', class: 'toast-close', attrs: { 'aria-label': 'Dismiss notification' }, text: '×' });
  const node = el('div', { class: `toast toast-${tone}`, attrs: { role: tone === 'error' ? 'alert' : 'status' } },
    el('div', { class: 'toast-body' },
      el('div', { class: 'toast-msg', text: message }),
      hint ? el('div', { class: 'toast-hint', text: hint }) : null),
    close);
  const remove = () => node.remove();
  close.addEventListener('click', remove);
  region.append(node);
  if (timeout) setTimeout(remove, tone === 'error' ? Math.max(timeout, 9000) : timeout);
}

export function toastError(err, prefix) {
  const msg = err?.message || String(err);
  toast(prefix ? `${prefix}: ${msg}` : msg, { tone: 'error', hint: err?.hint });
}

/** Inline error box (for forms/panels) showing message + hint. */
export function errorBox(err) {
  return el('div', { class: 'error-box', attrs: { role: 'alert' } },
    el('strong', { text: err?.message || String(err) }),
    err?.hint ? el('div', { class: 'hint', text: err.hint }) : null,
    err?.code ? el('div', { class: 'muted small', text: `Code: ${err.code}` }) : null);
}

// ---------- dialogs ----------
/**
 * Open a modal <dialog>. `build(body, close)` fills the content.
 * Returns a promise resolved with the value passed to close().
 */
export function openDialog({ title, build, className }) {
  return new Promise((resolve) => {
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const body = el('div', { class: 'dialog-body' });
    const dialog = el('dialog', { class: ['dialog', className], attrs: { 'aria-labelledby': titleId } },
      el('h2', { id: titleId, class: 'dialog-title', text: title }),
      body);
    let result;
    const close = (value) => { result = value; dialog.close(); };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    dialog.addEventListener('cancel', () => { result = undefined; });
    build(body, close);
    document.body.append(dialog);
    dialog.showModal();
    const focusTarget = body.querySelector('[autofocus], input, textarea, select') || body.querySelector('button');
    focusTarget?.focus();
  });
}

/**
 * Confirm dialog. Resolves true/false. If `typeToConfirm` is given, the user must type it exactly.
 * `extra(body)` may append additional controls; their values can be read before resolve via `onConfirm`.
 */
export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = false, typeToConfirm, extra } = {}) {
  return openDialog({
    title,
    build(body, close) {
      if (message) body.append(el('p', { text: message }));
      let extraState;
      if (extra) extraState = extra(body);
      const ok = el('button', { type: 'submit', class: danger ? 'btn btn-danger' : 'btn btn-primary', text: confirmLabel });
      let input;
      if (typeToConfirm) {
        const id = `ttc-${Math.random().toString(36).slice(2)}`;
        input = el('input', { id, type: 'text', autocomplete: 'off', spellcheck: false, attrs: { autofocus: true } });
        ok.disabled = true;
        input.addEventListener('input', () => { ok.disabled = input.value !== typeToConfirm; });
        body.append(el('label', { htmlFor: id, class: 'field' },
          el('span', { class: 'field-label', text: `Type ${typeToConfirm} to confirm` }), input));
      }
      const form = el('form', { class: 'dialog-actions', attrs: { method: 'dialog' } },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', on: { click: () => close(false) } }),
        ok);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (typeToConfirm && input.value !== typeToConfirm) return;
        close(extraState !== undefined ? { confirmed: true, ...extraState() } : true);
      });
      body.append(form);
    },
  }).then((v) => v || false);
}

/** Prompt for a single text value. Resolves string or null. */
export function promptDialog({ title, label, value = '', maxLength = 100, confirmLabel = 'Save', placeholder } = {}) {
  return openDialog({
    title,
    build(body, close) {
      const id = `pr-${Math.random().toString(36).slice(2)}`;
      const input = el('input', { id, type: 'text', value, maxLength, placeholder, required: true, attrs: { autofocus: true } });
      const form = el('form', {},
        el('label', { htmlFor: id, class: 'field' }, el('span', { class: 'field-label', text: label }), input),
        el('div', { class: 'dialog-actions' },
          el('button', { type: 'button', class: 'btn', text: 'Cancel', on: { click: () => close(null) } }),
          el('button', { type: 'submit', class: 'btn btn-primary', text: confirmLabel })));
      form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); });
      body.append(form);
    },
  }).then((v) => (v === undefined ? null : v));
}

/** Run an async action with a button disabled + busy state. */
export async function withBusy(button, fn) {
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally {
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  }
}

/** Labeled form field wrapper. */
export function field(label, control, { help, errorKey } = {}) {
  if (!control.id) control.id = `f-${Math.random().toString(36).slice(2)}`;
  const helpEl = help ? el('span', { class: 'field-help', id: `${control.id}-help`, text: help }) : null;
  const errEl = el('span', { class: 'field-error', id: `${control.id}-err`, attrs: { 'aria-live': 'polite' } });
  if (errorKey) errEl.dataset.errorFor = errorKey;
  const describedBy = [helpEl?.id, errEl.id].filter(Boolean).join(' ');
  control.setAttribute('aria-describedby', describedBy);
  return el('label', { class: 'field', htmlFor: control.id }, el('span', { class: 'field-label', text: label }), control, helpEl, errEl);
}

/** Trigger a browser download of a same-origin GET endpoint. */
export function download(url) {
  const a = el('a', { href: url, attrs: { download: '' }, class: 'visually-hidden' });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Summarize an activity details object into a short single-line string. */
export function summarizeDetails(details, max = 160) {
  if (details === null || details === undefined || details === '') return '';
  let d = details;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return d.length > max ? `${d.slice(0, max)}…` : d; }
  }
  if (typeof d !== 'object') return String(d);
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || v === '') continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${val}`);
  }
  const s = parts.join(' · ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const EVENT_LABELS = {
  'app.start': 'App started',
  'scheduler.start': 'Scheduler started',
  'scheduler.pause': 'Scheduler paused',
  'scheduler.resume': 'Scheduler resumed',
  'scheduler.stop': 'Scheduler stopped',
  'scheduler.tick_skipped': 'Tick skipped',
  'scheduler.limit_reached': 'Limit reached',
  'scheduler.error': 'Scheduler error',
  'message.sent': 'Message sent',
  'message.failed': 'Message failed',
  'message.created': 'Message created',
  'message.updated': 'Message updated',
  'message.deleted': 'Message deleted',
  'message.imported': 'Messages imported',
  'draft.generated': 'Drafts generated',
  'draft.approved': 'Drafts approved',
  'draft.rejected': 'Drafts rejected',
  'connection.added': 'Connection added',
  'connection.refreshed': 'Token refreshed',
  'connection.disconnected': 'Connection disconnected',
  'connection.removed': 'Connection removed',
  'connection.error': 'Connection error',
  'data.cleanup': 'Local data deleted',
};
export const eventLabel = (t) => EVENT_LABELS[t] || t || '—';

/** Activity timestamp: contract stores `ts`; accept `createdAt` defensively. */
export const entryTime = (e) => e?.ts || e?.createdAt || null;
