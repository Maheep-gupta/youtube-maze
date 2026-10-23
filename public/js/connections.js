// Accounts view: every authorized sender account, each with its own OAuth grant (tokens stay on
// the server), connection status and workflow state.
import { api } from './api.js';
import { el, clear, pill, timeEl, toast, toastError, errorBox, confirmDialog, promptDialog, withBusy, CONNECTION_TONES, STATE_TONES } from './ui.js';
import { refreshStatus } from './store.js';

const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/** Only follow an https Google URL returned by our own server. */
function goToGoogle(authUrl) {
  const u = new URL(authUrl);
  if (u.protocol !== 'https:' || u.hostname !== 'accounts.google.com') throw new Error('Unexpected authorization URL.');
  window.location.assign(u.href);
}

const SCOPE_NAMES = {
  'youtube.force-ssl': 'Manage YouTube account (required to post chat messages)',
  youtube: 'Manage YouTube account',
  'youtube.readonly': 'View YouTube account',
  'youtube.upload': 'Upload YouTube videos',
  openid: 'Sign-in identity',
  email: 'View email address',
  profile: 'View basic profile',
  'userinfo.email': 'View email address',
  'userinfo.profile': 'View basic profile',
};

export function scopeName(scope) {
  const key = String(scope).replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
  return SCOPE_NAMES[key] || scope;
}

let refs;

export function init(container) {
  refs = {
    list: el('div', { class: 'cards' }),
    error: el('div'),
    connectBtn: el('button', { type: 'button', class: 'btn btn-primary', text: 'Add YouTube Account' }),
    connectNote: el('p', { class: 'muted small' }),
    testBtn: el('button', { type: 'button', class: 'btn', text: 'Add test connection' }),
    provider: el('span'),
  };

  refs.connectBtn.addEventListener('click', () => withBusy(refs.connectBtn, async () => {
    try {
      const { authUrl } = await api.post('/api/connections/youtube/start', {});
      goToGoogle(authUrl);
    } catch (err) {
      toastError(err, 'Could not start Google authorization');
    }
  }));

  refs.testBtn.addEventListener('click', async () => {
    const label = await promptDialog({ title: 'Add test connection', label: 'Label', value: 'Test channel', maxLength: 80, confirmLabel: 'Add' });
    if (!label) return;
    try { await api.post('/api/connections/test', { label }); toast('Test connection added. Nothing is posted with test connections.', { tone: 'success' }); load(); refreshStatus(); }
    catch (err) { toastError(err, 'Could not add test connection'); }
  });

  const includeMessagesId = 'cleanup-include-messages';
  const dangerBtn = el('button', { type: 'button', class: 'btn btn-danger', text: 'Delete all local data' });
  dangerBtn.addEventListener('click', async () => {
    const res = await confirmDialog({
      title: 'Delete all local data?',
      message: "This stops every account's workflow, revokes and removes every account connection, and clears activity logs, drafts and sessions. This cannot be undone.",
      confirmLabel: 'Delete everything',
      danger: true,
      typeToConfirm: 'DELETE',
      extra(body) {
        const cb = el('input', { type: 'checkbox', id: includeMessagesId });
        body.append(el('label', { class: 'check', htmlFor: includeMessagesId }, cb, el('span', { text: 'Also delete my message library' })));
        return () => ({ includeMessages: cb.checked });
      },
    });
    if (!res || !res.confirmed) return;
    try {
      await withBusy(dangerBtn, () => api.post('/api/system/cleanup', { confirm: 'DELETE', includeMessages: Boolean(res.includeMessages) }));
      toast('Local data deleted.', { tone: 'success' });
      load();
      refreshStatus();
    } catch (err) { toastError(err, 'Cleanup failed'); }
  });

  clear(container,
    el('header', { class: 'view-header' }, el('h1', { text: 'Accounts' }), refs.provider),
    el('section', { class: 'card' },
      el('div', { class: 'card-title-row' },
        el('h2', { class: 'card-title', text: 'Sender accounts' }),
        el('div', { class: 'btn-row' }, refs.connectBtn, refs.testBtn)),
      refs.connectNote,
      el('p', { class: 'note' }, el('strong', { text: 'We never ask for your Google password. ' }), 'Each account is authorized separately on Google\'s site; its tokens are stored encrypted on this PC and never sent to the browser. You can revoke access at any time here or in your Google Account settings.'),
      el('p', { class: 'note', text: "Each account has its own workflow in Scheduler. Several can run at once only when each posts to its own channel's stream; accounts are never rotated or combined to post in one chat." }),
      refs.error,
      refs.list),
    el('section', { class: 'card card-danger' },
      el('h2', { class: 'card-title', text: 'Danger zone' }),
      el('p', { class: 'muted', text: 'Remove all locally stored data, including encrypted tokens. Your YouTube channel itself is not affected.' }),
      dangerBtn));
}

function kv(label, value) {
  return [el('dt', { text: label }), el('dd', {}, value ?? '—')];
}

const enc = (id) => encodeURIComponent(id);

function permissionsPill(c) {
  if (c.provider === 'test') return pill('Not needed (test)', 'grey');
  const scopes = Array.isArray(c.scopes) ? c.scopes : [];
  return scopes.includes(REQUIRED_SCOPE) ? pill('Permissions OK', 'green') : pill('Missing YouTube permission', 'red');
}

function connectionCard(c) {
  const checkResult = el('div', { class: 'check-result', attrs: { 'aria-live': 'polite' } });
  const canReconnect = c.provider === 'youtube' && (c.status === 'disconnected' || c.status === 'error');
  const connectBtn = el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Connect', hidden: !canReconnect, attrs: { title: 'Re-authorize this same channel with Google' } });
  const refreshBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Refresh Status', disabled: c.status === 'disconnected' });
  const checkBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Check stream', disabled: c.status !== 'connected' });
  const disconnectBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Disconnect', disabled: c.status === 'disconnected' });
  const removeBtn = el('button', { type: 'button', class: 'btn btn-sm btn-danger-ghost', text: 'Remove' });
  const workflowActive = c.workflowState === 'running' || c.workflowState === 'paused';

  connectBtn.addEventListener('click', () => withBusy(connectBtn, async () => {
    try {
      const { authUrl } = await api.post(`/api/connections/${enc(c.id)}/reconnect`, {});
      goToGoogle(authUrl);
    } catch (err) {
      if (err.code === 'ACCOUNT_MISMATCH') checkResult.replaceChildren(errorBox({ code: err.code, message: err.message, hint: err.hint || CALLBACK_ERRORS.ACCOUNT_MISMATCH.hint }));
      else toastError(err, `Could not reconnect "${c.label}"`);
    }
  }));

  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, async () => {
    checkResult.replaceChildren();
    try {
      const updated = await api.post(`/api/connections/${enc(c.id)}/refresh`, {});
      toast(`"${updated?.label || c.label}": ${updated?.status || 'status refreshed'}.`, { tone: updated?.status === 'connected' ? 'success' : 'info' });
      load();
    } catch (err) {
      checkResult.append(errorBox(err));
      load({ keep: true });
    }
  }));

  checkBtn.addEventListener('click', () => withBusy(checkBtn, async () => {
    checkResult.replaceChildren();
    try {
      const r = await api.post(`/api/connections/${enc(c.id)}/check`, {});
      if (r.broadcast) {
        checkResult.append(el('div', {}, pill('Live', 'green'), ' ', el('strong', { text: r.broadcast.title || 'Untitled broadcast' })));
        checkResult.append(r.chat?.available
          ? el('div', { class: 'muted small', text: 'Live chat is available.' })
          : el('div', { class: 'muted small', text: `Live chat unavailable${r.chat?.reason ? `: ${r.chat.reason}` : '.'}` }));
      } else {
        checkResult.append(el('div', {}, pill('Not live', 'grey'), ' ', el('span', { class: 'muted small', text: 'No active livestream on this channel.' })));
      }
    } catch (err) {
      checkResult.append(errorBox(err));
    }
  }));

  disconnectBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Disconnect account?',
      message: `Revoke access for "${c.label}" and delete its stored tokens?${workflowActive ? " This stops the account's running workflow." : ''} You can reconnect later.`,
      confirmLabel: 'Disconnect', danger: true,
    });
    if (!ok) return;
    try { await withBusy(disconnectBtn, () => api.post(`/api/connections/${enc(c.id)}/disconnect`, {})); toast('Account disconnected.', { tone: 'success' }); load(); refreshStatus(); }
    catch (err) { toastError(err, 'Could not disconnect'); }
  });

  removeBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Remove account?',
      message: `Remove "${c.label}" from this app? Its workflow is stopped, access is revoked, and the account, its settings and its stream selection are deleted.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    try { await withBusy(removeBtn, () => api.del(`/api/connections/${enc(c.id)}`)); toast('Account removed.', { tone: 'success' }); load(); refreshStatus(); }
    catch (err) { toastError(err, 'Could not remove account'); }
  });

  const scopes = Array.isArray(c.scopes) ? c.scopes : [];
  const wf = c.workflowState || 'idle';
  return el('article', { class: 'card conn-card', dataset: { accountId: c.id } },
    el('div', { class: 'card-title-row' },
      el('h3', { class: 'card-title', text: c.label || 'Unnamed account' }),
      el('span', { class: 'pill-row' },
        pill(c.status || 'unknown', CONNECTION_TONES[c.status] || 'grey'),
        pill(`Workflow: ${wf}`, STATE_TONES[wf] || 'grey'))),
    el('dl', { class: 'kv' },
      kv('Provider', c.isTestMode || c.provider === 'test' ? [c.provider, ' ', pill('Test', 'amber')] : c.provider),
      c.externalId ? kv('Channel ID', el('code', { text: c.externalId })) : null,
      kv('Permissions', [permissionsPill(c), scopes.length
        ? el('ul', { class: 'plain-list' }, scopes.map((sc) => el('li', { text: scopeName(sc), attrs: { title: sc } })))
        : null]),
      kv('Last successful use', c.lastUsedAt ? timeEl(c.lastUsedAt) : el('span', { class: 'muted', text: 'never' })),
      kv('Connected', c.createdAt ? timeEl(c.createdAt) : '—')),
    c.lastError ? el('div', { class: 'error-box' }, el('strong', { text: 'Last error' }), el('div', { text: c.lastError })) : null,
    checkResult,
    el('div', { class: 'btn-row' }, connectBtn, refreshBtn, checkBtn, disconnectBtn, removeBtn));
}

export async function load({ keep = false } = {}) {
  try {
    const data = await api.get('/api/connections');
    refs.error.replaceChildren();
    if (keep) return; // leave cards (and an error shown in one) in place
    refs.connectBtn.disabled = !data.oauthConfigured;
    refs.connectNote.textContent = data.oauthConfigured
      ? ''
      : 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env — see "Google Cloud setup" in the README — then restart the app.';
    refs.connectNote.hidden = Boolean(data.oauthConfigured);
    refs.provider.replaceChildren(data.chatProvider ? pill(`Chat provider: ${data.chatProvider}`, data.chatProvider === 'test' ? 'amber' : 'grey') : '');
    const items = data.items || [];
    clear(refs.list, items.length ? items.map(connectionCard) : el('p', { class: 'empty', text: 'No accounts yet. Add a YouTube account to authorize it with Google.' }));
  } catch (err) {
    clear(refs.error, errorBox(err));
  }
}

const CALLBACK_ERRORS = {
  ACCOUNT_MISMATCH: {
    message: 'Reconnect was rejected: you signed in with a different YouTube channel than this account.',
    hint: 'Sign in with the channel shown on the account card, or use "Add YouTube Account" to add the other channel as a separate account.',
  },
};

/** An OAuth callback may come back as #connections?error=CODE; show it once, then drop it from the URL. */
function showCallbackError() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const code = q.get('error');
  if (!code) return;
  const known = CALLBACK_ERRORS[code];
  clear(refs.error, errorBox({ code, message: known?.message || q.get('message') || 'Google authorization did not complete.', hint: known?.hint }));
  history.replaceState(null, '', '#connections');
}

export function show() {
  load().then(showCallbackError);
}
