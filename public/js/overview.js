import { api } from './api.js';
import { el, clear, pill, timeEl, categoryLabel, CATEGORIES, eventLabel, entryTime, LEVEL_TONES, errorBox, summarizeDetails } from './ui.js';
import { onWorkflows, onTick, countdownText, statePill, setAppTestMode, aggregatePill, runAction, selectAccount, isActive } from './store.js';
import { streamSummary } from './streamSetup.js';

let root;
let refs;
let visible = false;
let refreshTimer = null;
let lastStates = '';
const rows = new Map(); // connectionId -> row refs (kept across polls so buttons keep focus/busy state)

function card(title, ...body) {
  return el('section', { class: 'card' }, el('h2', { class: 'card-title', text: title }), ...body);
}

export function init(container) {
  root = container;
  refs = {
    error: el('div'),
    app: el('div', { class: 'kv' }),
    youtube: el('div', { class: 'kv' }),
    wfPill: el('span', { class: 'workflows-summary' }),
    wfList: el('div', { class: 'workflow-list' }),
    wfEmpty: el('p', { class: 'empty', hidden: true }, 'No accounts yet. ', el('a', { href: '#connections', class: 'link', text: 'Add an account →' })),
    messages: el('div'),
    ai: el('div', { class: 'kv' }),
    activity: el('ul', { class: 'activity-list' }),
  };
  clear(root,
    el('header', { class: 'view-header' },
      el('h1', { text: 'Overview' }),
      el('button', { type: 'button', class: 'btn btn-ghost', text: 'Refresh', on: { click: () => load() } })),
    refs.error,
    el('div', { class: 'grid grid-2' },
      card('Application', refs.app),
      card('Accounts', refs.youtube,
        el('a', { href: '#connections', class: 'link small', text: 'Manage accounts →' }))),
    el('section', { class: 'card card-accent workflows-card' },
      el('div', { class: 'card-title-row' }, el('h2', { class: 'card-title', text: 'Workflows' }), refs.wfPill),
      refs.wfEmpty,
      refs.wfList,
      el('p', { class: 'note', text: "One workflow per account, each bound to its own selected livestream. Several can run at once only when each posts to its own channel's stream." })),
    el('div', { class: 'grid grid-3' },
      card('Message library', refs.messages,
        el('a', { href: '#studio', class: 'link small', text: 'Open Message Studio →' })),
      card('AI generation', refs.ai),
      card('Recent activity', refs.activity,
        el('a', { href: '#logs', class: 'link small', text: 'All activity →' }))));

  onWorkflows(renderWorkflows);
  onTick(() => {
    if (!visible) return;
    for (const r of rows.values()) r.countdown.textContent = countdownText(r.status);
  });
}

function kv(label, value) {
  return [el('dt', { text: label }), el('dd', {}, value)];
}

function buildRow(id) {
  const r = {
    label: el('strong'),
    state: el('span'),
    stream: el('div', { class: 'small' }),
    meta: el('div', { class: 'muted small' }),
    countdown: el('span', { class: 'countdown countdown-sm', attrs: { 'aria-live': 'off' }, text: '--:--' }),
    review: el('div', { class: 'review-note small', hidden: true }),
    errors: el('div', { class: 'control-errors' }),
    start: el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Start' }),
    stop: el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Stop' }),
    status: null,
  };
  r.start.addEventListener('click', () => runAction(id, 'start', r.start, r.errors));
  r.stop.addEventListener('click', () => runAction(id, 'stop', r.stop, r.errors));
  const open = el('a', { href: '#scheduler', class: 'link small', text: 'Open in Scheduler →', on: { click: () => selectAccount(id) } });
  r.el = el('article', { class: 'workflow-row', dataset: { accountId: id } },
    el('div', { class: 'workflow-head' }, r.label, r.state),
    r.stream,
    el('div', { class: 'workflow-next' }, el('span', { class: 'muted small', text: 'Next message in ' }), r.countdown),
    r.meta,
    r.review,
    el('div', { class: 'btn-row' }, r.start, r.stop, open),
    r.errors);
  return r;
}

function renderWorkflows(items) {
  if (!refs) return;
  refs.wfPill.replaceChildren(aggregatePill(items));
  refs.wfEmpty.hidden = items.length > 0;
  const seen = new Set();
  for (const [index, w] of items.entries()) {
    const id = w.connectionId;
    seen.add(id);
    let r = rows.get(id);
    if (!r) { r = buildRow(id); rows.set(id, r); }
    const st = w.status || {};
    r.status = st;
    r.label.textContent = w.label || id;
    clear(r.state, statePill(st.state), w.connectionStatus && w.connectionStatus !== 'connected' ? [' ', pill(w.connectionStatus, 'red')] : null);
    const stream = st.stream ?? w.selection ?? null;
    clear(r.stream, stream ? streamSummary(stream) : el('span', { class: 'muted', text: 'No livestream selected' }));
    const t = st.today || {};
    const parts = [`Today: ${t.sent ?? 0}${t.limit ? ` / ${t.limit}` : ''} sent`];
    if (st.session && isActive(st)) parts.push(`${st.session.messagesSent ?? 0} sent this session`);
    if (!isActive(st) && st.session?.stopReason) parts.push(`Last stop: ${st.session.stopReason}`);
    r.meta.textContent = parts.join(' · ');
    r.countdown.textContent = countdownText(st);
    r.review.hidden = !(isActive(st) && st.pendingReview);
    if (!r.review.hidden && !r.review.childNodes.length) r.review.append('Message awaiting review — approve or skip it in Scheduler.');
    if (!r.start.getAttribute('aria-busy')) r.start.disabled = st.state !== 'idle';
    if (!r.stop.getAttribute('aria-busy')) r.stop.disabled = !isActive(st);
    // Keep server order without moving rows that are already in place (moving would drop focus).
    const at = refs.wfList.children[index];
    if (at !== r.el) refs.wfList.insertBefore(r.el, at ?? null);
  }
  for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
  // Reload overview data when any workflow changes state (e.g. auto-stop).
  const states = items.map((w) => `${w.connectionId}:${w.status?.state}`).join('|');
  if (lastStates && lastStates !== states && visible) load();
  lastStates = states;
}

function render(data, connections) {
  setAppTestMode(data.app?.testMode);

  clear(refs.app, el('dl', {},
    kv('Status', pill('Running', 'green')),
    kv('Version', data.app?.version || '—'),
    kv('Chat provider', data.app?.chatProvider || '—'),
    kv('Mode', data.app?.testMode ? pill('Test mode', 'amber') : pill('Live posting', 'green'))));

  const c = data.connections || { total: 0, connected: 0 };
  const connectedLabels = (connections || []).filter((x) => x.status === 'connected').map((x) => x.label).filter(Boolean);
  clear(refs.youtube, el('dl', {},
    kv('Status', c.connected > 0 ? pill('Connected', 'green') : c.total > 0 ? pill('Not connected', 'amber') : pill('No accounts', 'grey')),
    kv('Accounts', `${c.connected} connected of ${c.total}`),
    connectedLabels.length ? kv('Channels', connectedLabels.join(', ')) : null));

  const m = data.messages || { total: 0, enabled: 0, byCategory: {} };
  const rows = CATEGORIES.map((cat) => {
    const bc = m.byCategory?.[cat] || { total: 0, enabled: 0 };
    return el('tr', {}, el('th', { attrs: { scope: 'row' }, text: categoryLabel(cat) }), el('td', { class: 'num', text: bc.total }), el('td', { class: 'num', text: bc.enabled }));
  });
  clear(refs.messages,
    el('div', { class: 'stat-row' },
      el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: m.total }), el('div', { class: 'stat-label', text: 'Total' })),
      el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: m.enabled }), el('div', { class: 'stat-label', text: 'Enabled' }))),
    el('table', { class: 'table table-compact' },
      el('thead', {}, el('tr', {}, el('th', { attrs: { scope: 'col' }, text: 'Category' }), el('th', { class: 'num', attrs: { scope: 'col' }, text: 'Total' }), el('th', { class: 'num', attrs: { scope: 'col' }, text: 'Enabled' }))),
      el('tbody', {}, rows)));

  const ai = data.ai || {};
  clear(refs.ai, el('dl', {},
    kv('Status', ai.configured ? pill('Configured', 'green') : pill('Not configured', 'grey')),
    ai.configured ? kv('Provider', [ai.provider, ai.model].filter(Boolean).join(' · ') || '—') : null,
    ai.configured && ai.baseUrlHost ? kv('Endpoint', ai.baseUrlHost) : null));
  if (!ai.configured) refs.ai.append(el('p', { class: 'muted small', text: 'AI not configured — preset library will be used.' }));

  const items = data.recentActivity || [];
  clear(refs.activity, items.length ? items.map(activityItem) : el('li', { class: 'empty', text: 'No activity yet.' }));
}

function activityItem(e) {
  const summary = summarizeDetails(e.details, 100);
  return el('li', { class: 'activity-item' },
    pill(e.level || 'info', LEVEL_TONES[e.level] || 'grey'),
    el('div', { class: 'activity-main' },
      el('div', { class: 'activity-event', text: eventLabel(e.eventType) }),
      summary || e.outcome ? el('div', { class: 'muted small truncate', text: [e.outcome, summary].filter(Boolean).join(' — ') }) : null),
    timeEl(entryTime(e)));
}

export async function load() {
  try {
    const [data, conns] = await Promise.all([
      api.get('/api/overview'),
      api.get('/api/connections').catch(() => null),
    ]);
    refs.error.replaceChildren();
    render(data, conns?.items);
  } catch (err) {
    clear(refs.error, errorBox(err));
  }
}

export function show() {
  visible = true;
  load();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
}

export function hide() {
  visible = false;
  clearInterval(refreshTimer);
}
