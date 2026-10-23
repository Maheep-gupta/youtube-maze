import { api } from './api.js';
import { el, clear, pill, formatTime, categoryLabel, eventLabel, entryTime, LEVEL_TONES, summarizeDetails, toast, toastError, errorBox, confirmDialog, withBusy, download } from './ui.js';

const FILTERS = [
  { key: 'all', label: 'All', query: {} },
  { key: 'success', label: 'Success', query: { level: 'success' } },
  { key: 'warning', label: 'Warnings', query: { level: 'warning' } },
  { key: 'error', label: 'Errors', query: { level: 'error' } },
  { key: 'scheduler', label: 'Scheduler', query: { group: 'scheduler' } },
];
const PAGE = 100;

let refs;
let filter = FILTERS[0];
let accountId = ''; // '' = all accounts
let accountLabels = new Map(); // connectionId -> label, for the Account column

/** Current filter as API query params (shared by list and export). */
const currentQuery = () => ({ ...filter.query, ...(accountId ? { connectionId: accountId } : {}) });
let nextBeforeId = null;
let loading = false;

export function init(container) {
  refs = {
    chips: el('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter activity' } }),
    tbody: el('tbody'),
    empty: el('p', { class: 'empty', hidden: true, text: 'No activity for this filter.' }),
    more: el('button', { type: 'button', class: 'btn', text: 'Load more', hidden: true }),
    error: el('div'),
    account: el('select', { name: 'logAccount' }),
  };
  refs.account.addEventListener('change', () => { accountId = refs.account.value; load(); });
  for (const f of FILTERS) {
    const chip = el('button', { type: 'button', class: 'chip', text: f.label, attrs: { 'aria-pressed': String(f === filter) } });
    chip.addEventListener('click', () => {
      filter = f;
      for (const c of refs.chips.children) c.setAttribute('aria-pressed', String(c === chip));
      load();
    });
    refs.chips.append(chip);
  }
  refs.more.addEventListener('click', () => load({ append: true }));

  const exportQuery = (format) => {
    const qs = new URLSearchParams({ format, ...currentQuery() });
    return `/api/logs/export?${qs}`;
  };
  const clearBtn = el('button', { type: 'button', class: 'btn btn-danger-ghost', text: 'Clear logs' });
  clearBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Clear activity logs?', message: 'All activity log entries will be permanently deleted.', confirmLabel: 'Clear logs', danger: true });
    if (!ok) return;
    try { const r = await withBusy(clearBtn, () => api.del('/api/logs', { confirm: true })); toast(`Cleared ${r?.cleared ?? 0} log entries.`, { tone: 'success' }); load(); }
    catch (err) { toastError(err, 'Could not clear logs'); }
  });

  clear(container,
    el('header', { class: 'view-header' }, el('h1', { text: 'Activity Logs' }),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn', text: 'Export JSON', on: { click: () => download(exportQuery('json')) } }),
        el('button', { type: 'button', class: 'btn', text: 'Export CSV', on: { click: () => download(exportQuery('csv')) } }),
        clearBtn)),
    el('section', { class: 'card' },
      el('div', { class: 'toolbar' }, refs.chips,
        el('label', { class: 'toolbar-field' }, el('span', { class: 'muted small', text: 'Account' }), refs.account),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Refresh', on: { click: () => load() } })),
      refs.error,
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, ['Time', 'Account', 'Event', 'Level', 'Category', 'Outcome', 'Details'].map((h) => el('th', { attrs: { scope: 'col' }, text: h })))),
          refs.tbody)),
      refs.empty,
      el('div', { class: 'pager' }, refs.more)));
}

function row(e) {
  const ts = entryTime(e);
  const details = summarizeDetails(e.details);
  return el('tr', {},
    el('td', { class: 'nowrap' }, el('time', { attrs: { datetime: ts || undefined }, text: formatTime(ts) })),
    el('td', { text: e.connectionId ? (accountLabels.get(e.connectionId) || 'Removed account') : '—' }),
    el('td', {}, el('div', { text: eventLabel(e.eventType) }), el('code', { class: 'muted small', text: e.eventType || '' })),
    el('td', {}, pill(e.level || 'info', LEVEL_TONES[e.level] || 'grey')),
    el('td', { text: e.category ? categoryLabel(e.category) : '—' }),
    el('td', { text: e.outcome || '—' }),
    el('td', { class: 'cell-details', text: details || '—', attrs: { title: details || undefined } }));
}

export async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  try {
    const query = { ...currentQuery(), limit: PAGE };
    if (append && nextBeforeId) query.beforeId = nextBeforeId;
    const data = await api.get('/api/logs', query);
    const items = data.items || [];
    if (!append) refs.tbody.replaceChildren();
    refs.tbody.append(...items.map(row));
    nextBeforeId = data.nextBeforeId ?? null;
    refs.more.hidden = !nextBeforeId;
    refs.empty.hidden = refs.tbody.children.length > 0;
    refs.error.replaceChildren();
  } catch (err) {
    clear(refs.error, errorBox(err));
  } finally {
    loading = false;
  }
}

/** Fill the Account filter from the current accounts (labels only). */
async function loadAccounts() {
  let items = [];
  try { items = (await api.get('/api/connections')).items || []; } catch { /* filter stays "All" */ }
  accountLabels = new Map(items.map((c) => [c.id, c.label || c.id]));
  if (accountId && !accountLabels.has(accountId)) accountId = '';
  refs.account.replaceChildren(
    el('option', { value: '', text: 'All accounts' }),
    ...items.map((c) => el('option', { value: c.id, text: c.label || c.id })));
  refs.account.value = accountId;
}

export async function show() {
  await loadAccounts();
  load();
}
