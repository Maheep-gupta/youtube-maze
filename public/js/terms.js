// Terms view: the current External Livestream Terms and the local history of decisions.
import { api } from './api.js';
import { el, clear, errorBox, pill } from './ui.js';
import { store } from './store.js';
import { getTerms, renderTerms } from './termsDialog.js';

let refs;

export function init(container) {
  refs = { terms: el('div'), history: el('div') };
  clear(container,
    el('header', { class: 'view-header' }, el('h1', { text: 'Terms' })),
    el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'External Livestream Terms (current version)' }),
      el('p', { class: 'note', text: 'Shown before a scheduler starts on a livestream that is not owned by its account. Accepting is a local record of your confirmation; it is not permission from YouTube or the stream owner, and every authorization and permission check still applies.' }),
      refs.terms),
    el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Your previous decisions' }),
      el('p', { class: 'muted small', text: 'Stored only in this app\'s local database. A decision counts only for the terms version it was made on; when the terms change materially, you are asked again. "Delete all local data" removes this history.' }),
      refs.history));
}

const accountName = (id) => store.workflows.find((w) => w.connectionId === id)?.label || `${String(id).slice(0, 8)} (removed)`;

function historyTable(items) {
  if (!items.length) return el('p', { class: 'empty', text: 'No decisions recorded yet.' });
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['Time (UTC)', 'Account', 'YouTube channel id', 'Video id', 'Terms version', 'Decision', 'Valid now'].map((h) => el('th', { attrs: { scope: 'col' }, text: h })))),
      el('tbody', {}, items.map((r) => el('tr', {},
        el('td', {}, el('time', { attrs: { datetime: r.createdAt }, text: r.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') })),
        el('td', { text: accountName(r.connectionId) }),
        el('td', {}, r.channelId ? el('code', { text: r.channelId }) : '—'),
        el('td', {}, el('code', { text: r.videoId })),
        el('td', { text: r.termsVersion }),
        el('td', {}, pill(r.status === 'accepted' ? 'Accepted' : 'Declined', r.status === 'accepted' ? 'green' : 'amber')),
        el('td', { text: r.currentVersion ? 'Current version' : 'Older version' }))))));
}

export async function show() {
  try {
    clear(refs.terms, renderTerms(await getTerms({ refresh: true })));
  } catch (err) {
    clear(refs.terms, errorBox(err));
  }
  try {
    const { items } = await api.get('/api/terms/acknowledgements?limit=200');
    clear(refs.history, historyTable(items || []));
  } catch (err) {
    clear(refs.history, errorBox(err));
  }
}

export function hide() {}
