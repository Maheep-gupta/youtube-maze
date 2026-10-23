import { AppError, ChatProviderError, notFound } from '../errors.js';
import { plain } from '../db/index.js';
import { redactString } from '../logger.js';
import { uuid } from '../security/crypto.js';

/**
 * Account connections (one row per authorized YouTube channel, plus Test Mode connections).
 *
 * Tokens are stored ONLY as cipher.encryptJson({ accessToken, refreshToken, expiresAt }) in
 * `encrypted_tokens`. No method of this service returns tokens except getAuth(), whose result is
 * passed straight to a chat provider and never serialized to a client or log.
 */
export const YOUTUBE_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const REFRESH_SKEW_MS = 60_000;
const MAX_ERROR_LEN = 500;
const STATUS_ERROR_CODES = new Set(['AUTH_FAILED', 'PERMISSION_DENIED', 'NOT_CONFIGURED']);

const safeMessage = (err) => redactString(err?.message ?? String(err ?? 'Unknown error')).slice(0, MAX_ERROR_LEN);

export function createConnectionsService({ db, cipher, activity, googleOAuth, chatProviders, clock = { now: () => Date.now() } }) {
  const nowIso = () => new Date(clock.now()).toISOString();
  const listeners = new Set();
  let workflowStateOf = () => 'idle';

  /** Subscribe to account events: (event, connectionId, err?) with event disconnected | removed | auth_error. */
  function onAccountEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function emit(event, connectionId, err) {
    for (const fn of listeners) {
      try { fn(event, connectionId, err); } catch { /* a listener must never break connection handling */ }
    }
  }
  /** The scheduler manager reports each account's workflow state ('idle' | 'running' | 'paused'). */
  function useWorkflowState(fn) { workflowStateOf = fn; }

  function logEvent(eventType, level, provider, details) {
    try {
      activity?.log({ eventType, level, provider, details });
    } catch {
      // Activity logging must never break connection handling.
    }
  }

  function toPublic(row) {
    const r = plain(row);
    let scopes = [];
    try { scopes = JSON.parse(r.scopes ?? '[]'); } catch { scopes = []; }
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      externalId: r.external_id ?? null,
      scopes: Array.isArray(scopes) ? scopes : [],
      status: r.status,
      lastUsedAt: r.last_used_at ?? null,
      lastError: r.last_error ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      isTestMode: Boolean(chatProviders?.[r.provider]?.isTestMode ?? r.provider === 'test'),
      workflowState: workflowStateOf(r.id) ?? 'idle',
    };
  }

  function getRow(id) {
    const row = db.prepare('SELECT * FROM account_connections WHERE id = ?').get(String(id));
    if (!row) throw notFound('Connection');
    return plain(row);
  }

  const list = () => db.prepare('SELECT * FROM account_connections ORDER BY created_at ASC, id ASC').all().map(toPublic);
  const get = (id) => toPublic(getRow(id));

  function decryptTokens(row) {
    if (!row.encrypted_tokens) return null;
    try {
      return cipher.decryptJson(row.encrypted_tokens);
    } catch {
      return null;
    }
  }

  function setError(id, message, err) {
    db.prepare("UPDATE account_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?")
      .run(String(message).slice(0, MAX_ERROR_LEN), nowIso(), id);
    emit('auth_error', id, err ?? new ChatProviderError('AUTH_FAILED', String(message)));
  }

  /**
   * Start Google sign-in. With `connectionId`, this re-authorizes THAT account: the callback accepts
   * only the same channel. Google is asked to show the account chooser every time.
   */
  async function beginYouTubeAuth({ connectionId } = {}) {
    if (connectionId) {
      const row = getRow(connectionId);
      if (row.provider !== 'youtube') throw new AppError('NOT_SUPPORTED', 'Only YouTube accounts can be reconnected through Google sign-in.', { status: 400 });
    }
    if (!googleOAuth.isConfigured()) {
      const err = new AppError('NOT_CONFIGURED', 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart the app.', { status: 400 });
      err.hint = 'See README: "Google Cloud OAuth setup". Use an OAuth client of type "Web application" with redirect URI ' + googleOAuth.redirectUri;
      throw err;
    }
    const { url } = googleOAuth.createAuthorizationUrl(connectionId ? { connectionId } : {});
    return { authUrl: url };
  }

  async function completeYouTubeAuth({ code, state, error } = {}) {
    if (error) {
      googleOAuth.discardState?.(state);
      const reason = String(error).replace(/[^a-z0-9_.-]/gi, '').slice(0, 64) || 'unknown_error';
      logEvent('connection.error', 'warning', 'youtube', { stage: 'authorize', reason });
      if (reason === 'access_denied') {
        throw new AppError('OAUTH_DENIED', 'Authorization was cancelled or denied at Google. No account was connected.', { status: 400 });
      }
      throw new AppError('OAUTH_FAILED', `Google returned an error (${reason}). No account was connected.`, { status: 400 });
    }

    const tokens = await googleOAuth.exchangeCode({ code, state });
    const scopes = Array.isArray(tokens.scopes) ? tokens.scopes : [];
    let target = null;
    if (tokens.connectionId) {
      const t = db.prepare('SELECT * FROM account_connections WHERE id = ?').get(String(tokens.connectionId));
      if (!t) {
        await googleOAuth.revoke(tokens.refreshToken ?? tokens.accessToken);
        throw new AppError('NOT_FOUND', 'The account being reconnected no longer exists. Nothing was connected.', { status: 404 });
      }
      target = plain(t);
    }

    let channel;
    try {
      channel = await chatProviders.youtube.getAuthorizedChannel({ accessToken: tokens.accessToken });
    } catch (err) {
      await googleOAuth.revoke(tokens.refreshToken ?? tokens.accessToken);
      logEvent('connection.error', 'error', 'youtube', { stage: 'channel_lookup', code: err?.code, message: safeMessage(err) });
      if (err instanceof ChatProviderError) throw err;
      throw new AppError('OAUTH_FAILED', 'Could not read the YouTube channel for this account.', { status: 502 });
    }

    if (target && target.external_id !== channel.channelId) {
      // Never attach another channel's grant to this account (and never merge accounts).
      await googleOAuth.revoke(tokens.refreshToken ?? tokens.accessToken);
      logEvent('connection.error', 'warning', 'youtube', { connectionId: target.id, stage: 'reconnect', reason: 'channel_mismatch' });
      const signedIn = redactString(String(channel.title ?? '')).slice(0, 100);
      const expected = redactString(String(target.label ?? '')).slice(0, 100);
      throw new AppError('ACCOUNT_MISMATCH', `You signed in with a different channel than this account ("${signedIn}" instead of "${expected}"). Nothing was changed. Reconnect and choose the Google account that owns "${expected}".`, { status: 409 });
    }

    const ts = nowIso();
    const existing = db.prepare("SELECT * FROM account_connections WHERE provider = 'youtube' AND external_id = ?").get(channel.channelId);
    const existingRow = existing ? plain(existing) : null;
    const hasScope = scopes.includes(YOUTUBE_REQUIRED_SCOPE);

    let encrypted = null;
    let expiresAt = null;
    let status = 'connected';
    let lastError = null;
    if (hasScope) {
      const previous = existingRow ? decryptTokens(existingRow) : null;
      const refreshToken = tokens.refreshToken ?? previous?.refreshToken ?? null;
      encrypted = cipher.encryptJson({ accessToken: tokens.accessToken, refreshToken, expiresAt: tokens.expiresAt });
      expiresAt = tokens.expiresAt;
    } else {
      // Don't keep a grant we can't use for posting; revoke it so the user can re-consent cleanly.
      await googleOAuth.revoke(tokens.refreshToken ?? tokens.accessToken);
      status = 'error';
      lastError = 'Missing required permission "Manage your YouTube account" (youtube.force-ssl). Reconnect and allow all requested permissions.';
    }

    let id;
    if (existingRow) {
      id = existingRow.id;
      db.prepare(`UPDATE account_connections SET label = ?, scopes = ?, status = ?, encrypted_tokens = ?, token_expires_at = ?,
        last_error = ?, updated_at = ? WHERE id = ?`)
        .run(channel.title, JSON.stringify(scopes), status, encrypted, expiresAt, lastError, ts, id);
    } else {
      id = uuid();
      db.prepare(`INSERT INTO account_connections (id, provider, label, external_id, scopes, status, encrypted_tokens, token_expires_at,
        last_error, created_at, updated_at) VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, channel.title, channel.channelId, JSON.stringify(scopes), status, encrypted, expiresAt, lastError, ts, ts);
    }

    if (hasScope) {
      logEvent('connection.added', 'success', 'youtube', { connectionId: id, label: channel.title, channelId: channel.channelId, scopes, reconnected: Boolean(existingRow) });
    } else {
      logEvent('connection.error', 'error', 'youtube', { connectionId: id, label: channel.title, reason: 'insufficient_scope', scopes });
    }
    return get(id);
  }

  function addTestConnection({ label } = {}) {
    const ts = nowIso();
    const id = uuid();
    const name = String(label ?? '').trim().slice(0, 80) || 'Test Mode';
    db.prepare(`INSERT INTO account_connections (id, provider, label, external_id, scopes, status, created_at, updated_at)
      VALUES (?, 'test', ?, NULL, '[]', 'connected', ?, ?)`).run(id, name, ts, ts);
    logEvent('connection.added', 'success', 'test', { connectionId: id, label: name, testMode: true });
    return get(id);
  }

  async function getAuth(id) {
    const row = getRow(id);
    if (chatProviders?.[row.provider]?.isTestMode || row.provider === 'test') {
      if (row.status === 'disconnected') throw new ChatProviderError('AUTH_FAILED', 'This Test Mode connection is disconnected.');
      return { test: true };
    }
    if (row.status === 'disconnected' || !row.encrypted_tokens) {
      throw new ChatProviderError('AUTH_FAILED', 'This account is not connected. Reconnect it from the Connections page.');
    }
    const tokens = decryptTokens(row);
    if (!tokens?.accessToken) {
      const err = new ChatProviderError('AUTH_FAILED', 'Stored credentials could not be read (encryption key changed?). Reconnect the account.');
      setError(row.id, err.message, err);
      logEvent('connection.error', 'error', row.provider, { connectionId: row.id, stage: 'decrypt' });
      throw err;
    }

    const expiresAtMs = Date.parse(tokens.expiresAt ?? row.token_expires_at ?? '');
    if (Number.isFinite(expiresAtMs) && expiresAtMs - clock.now() > REFRESH_SKEW_MS) {
      return { accessToken: tokens.accessToken, channelId: row.external_id ?? undefined };
    }

    let refreshed;
    try {
      refreshed = await googleOAuth.refresh(tokens.refreshToken);
    } catch (err) {
      const message = `Token refresh failed: ${safeMessage(err)}`;
      if (!(err instanceof ChatProviderError) || STATUS_ERROR_CODES.has(err.code)) setError(row.id, message, err);
      else db.prepare('UPDATE account_connections SET last_error = ?, updated_at = ? WHERE id = ?').run(message, nowIso(), row.id);
      logEvent('connection.error', 'error', row.provider, { connectionId: row.id, stage: 'refresh', code: err?.code, message: safeMessage(err) });
      if (err instanceof ChatProviderError) throw err;
      throw new ChatProviderError('AUTH_FAILED', message);
    }

    const next = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken, // Google usually omits it on refresh
      expiresAt: refreshed.expiresAt,
    };
    const scopesSql = Array.isArray(refreshed.scopes) ? JSON.stringify(refreshed.scopes) : row.scopes;
    db.prepare('UPDATE account_connections SET encrypted_tokens = ?, token_expires_at = ?, scopes = ?, updated_at = ? WHERE id = ?')
      .run(cipher.encryptJson(next), next.expiresAt, scopesSql, nowIso(), row.id);
    logEvent('connection.refreshed', 'info', row.provider, { connectionId: row.id, expiresAt: next.expiresAt });
    return { accessToken: next.accessToken, channelId: row.external_id ?? undefined };
  }

  function markUsed(id) {
    // A confirmed successful call proves the connection works again (clears a transient error).
    db.prepare(`UPDATE account_connections SET last_used_at = ?, updated_at = ?,
      status = CASE WHEN status = 'error' AND (encrypted_tokens IS NOT NULL OR provider = 'test') THEN 'connected' ELSE status END,
      last_error = CASE WHEN status = 'error' AND (encrypted_tokens IS NOT NULL OR provider = 'test') THEN NULL ELSE last_error END
      WHERE id = ?`).run(nowIso(), nowIso(), String(id));
  }

  function markError(id, err) {
    const row = db.prepare('SELECT id, provider, status FROM account_connections WHERE id = ?').get(String(id));
    if (!row) return;
    const message = safeMessage(err);
    if (STATUS_ERROR_CODES.has(err?.code) && row.status !== 'disconnected') {
      setError(row.id, message, err);
      logEvent('connection.error', 'error', row.provider, { connectionId: row.id, code: err.code, message });
    } else {
      db.prepare('UPDATE account_connections SET last_error = ?, updated_at = ? WHERE id = ?').run(message, nowIso(), row.id);
    }
  }

  async function disconnect(id) {
    const row = getRow(id);
    let revoked = false;
    const tokens = decryptTokens(row);
    if (tokens && row.provider === 'youtube') {
      revoked = await googleOAuth.revoke(tokens.refreshToken ?? tokens.accessToken);
    }
    db.prepare(`UPDATE account_connections SET encrypted_tokens = NULL, token_expires_at = NULL, status = 'disconnected',
      updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
    if (row.status !== 'disconnected' || row.encrypted_tokens) {
      logEvent('connection.disconnected', 'info', row.provider, { connectionId: row.id, label: row.label, revoked });
    }
    emit('disconnected', row.id);
    return get(row.id);
  }

  async function remove(id) {
    const row = getRow(id);
    await disconnect(row.id);
    db.prepare('UPDATE scheduler_settings SET connection_id = NULL WHERE connection_id = ?').run(row.id);
    db.prepare('DELETE FROM account_connections WHERE id = ?').run(row.id);
    emit('removed', row.id);
    logEvent('connection.removed', 'info', row.provider, { connectionId: row.id, label: row.label });
  }

  /**
   * Refresh Status: force a token refresh, re-read the channel and verify the posting scope. Updates
   * the account's status (connected, or error with a sanitized reason) and returns it. Never returns
   * tokens. Errors: AUTH_FAILED (expired/revoked), PERMISSION_DENIED (missing scope), NETWORK, QUOTA_EXCEEDED.
   */
  async function refresh(id) {
    const row = getRow(id);
    const provider = chatProviders?.[row.provider];
    try {
      if (provider?.isTestMode || row.provider === 'test') {
        if (row.status === 'disconnected') throw new ChatProviderError('AUTH_FAILED', 'This Test Mode connection is disconnected.');
      } else {
        if (row.status === 'disconnected' || !row.encrypted_tokens) {
          throw new ChatProviderError('AUTH_FAILED', 'This account is not connected. Reconnect it.');
        }
        const tokens = decryptTokens(row);
        if (!tokens?.accessToken) {
          throw new ChatProviderError('AUTH_FAILED', 'Stored credentials could not be read (encryption key changed?). Reconnect the account.');
        }
        const refreshed = await googleOAuth.refresh(tokens.refreshToken);
        let scopes = refreshed.scopes;
        if (!Array.isArray(scopes)) { try { scopes = JSON.parse(row.scopes ?? '[]'); } catch { scopes = []; } }
        const next = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? tokens.refreshToken, expiresAt: refreshed.expiresAt };
        db.prepare('UPDATE account_connections SET encrypted_tokens = ?, token_expires_at = ?, scopes = ?, updated_at = ? WHERE id = ?')
          .run(cipher.encryptJson(next), next.expiresAt, JSON.stringify(scopes), nowIso(), row.id);
        if (!scopes.includes(YOUTUBE_REQUIRED_SCOPE)) {
          const err = new ChatProviderError('PERMISSION_DENIED', 'Missing required permission "Manage your YouTube account" (youtube.force-ssl). Reconnect and allow all requested permissions.');
          err.reason = 'insufficientPermissions';
          throw err;
        }
        const channel = await provider.getAuthorizedChannel({ accessToken: next.accessToken });
        if (row.external_id && channel.channelId !== row.external_id) {
          throw new ChatProviderError('PERMISSION_DENIED', 'This grant now belongs to a different YouTube channel. Reconnect the account.');
        }
        if (channel.title) db.prepare('UPDATE account_connections SET label = ? WHERE id = ?').run(String(channel.title).slice(0, 200), row.id);
      }
    } catch (raw) {
      const err = raw instanceof ChatProviderError || raw?.name === 'ChatProviderError'
        ? raw : new ChatProviderError('UNKNOWN', safeMessage(raw));
      if (STATUS_ERROR_CODES.has(err.code)) setError(row.id, safeMessage(err), err);
      else db.prepare('UPDATE account_connections SET last_error = ?, updated_at = ? WHERE id = ?').run(safeMessage(err), nowIso(), row.id);
      logEvent('connection.error', 'error', row.provider, { connectionId: row.id, stage: 'refresh_status', code: err.code, message: safeMessage(err) });
      const status = { AUTH_FAILED: 401, PERMISSION_DENIED: 403, QUOTA_EXCEEDED: 429, RATE_LIMITED: 429, NOT_CONFIGURED: 400 }[err.code] ?? 502;
      const appErr = new AppError(err.code, safeMessage(err), { status });
      appErr.hint = err.hint;
      throw appErr;
    }
    db.prepare("UPDATE account_connections SET status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
    logEvent('connection.refreshed', 'info', row.provider, { connectionId: row.id, stage: 'refresh_status' });
    return get(row.id);
  }

  async function cleanupAll() {
    const ids = db.prepare('SELECT id FROM account_connections').all().map((r) => r.id);
    for (const id of ids) await remove(id);
    return ids.length;
  }

  return {
    list, get, beginYouTubeAuth, completeYouTubeAuth, addTestConnection, getAuth, markUsed, markError, disconnect, remove, cleanupAll,
    refresh, onAccountEvent, useWorkflowState,
  };
}
