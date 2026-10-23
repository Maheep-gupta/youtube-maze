import crypto from 'node:crypto';
import { AppError, ChatProviderError } from '../errors.js';
import { redactString } from '../logger.js';

/**
 * Google OAuth 2.0 for an installed/local web app: authorization-code flow with PKCE (S256).
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * Pending authorization requests (state -> PKCE verifier) live only in process memory:
 * single use, 10 minute TTL. Restarting the app invalidates in-flight logins, which is fine.
 * Nothing here logs or returns the client secret, codes, or tokens.
 */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const YOUTUBE_FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 50;
const TIMEOUT_MS = 15_000;

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/** Google returns granted scopes as a space-delimited string. */
export function parseScopes(scope) {
  if (Array.isArray(scope)) return scope.filter((s) => typeof s === 'string' && s);
  return String(scope ?? '').split(/\s+/).filter(Boolean);
}

export function createGoogleOAuth({ config, fetch = globalThis.fetch, clock = { now: () => Date.now() } }) {
  const scopes = [YOUTUBE_FORCE_SSL_SCOPE];
  const redirectUri = `${config.publicOrigin}/oauth/google/callback`;
  /** @type {Map<string, { verifier: string, expiresAt: number, connectionId: string|null }>} */
  const pending = new Map();

  const isConfigured = () => Boolean(config.google?.clientId && config.google?.clientSecret);

  function prune() {
    const now = clock.now();
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
    // Bound memory: drop the oldest entries (Map preserves insertion order).
    while (pending.size >= MAX_PENDING_STATES) pending.delete(pending.keys().next().value);
  }

  function requireConfigured() {
    if (!isConfigured()) {
      throw new AppError('NOT_CONFIGURED', 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart.', { status: 400 });
    }
  }

  /** `connectionId` (optional) marks this sign-in as re-authorizing that account; exchangeCode returns it. */
  function createAuthorizationUrl({ connectionId = null } = {}) {
    requireConfigured();
    prune();
    const state = base64url(crypto.randomBytes(24));
    const verifier = base64url(crypto.randomBytes(48)); // 64 chars, within RFC 7636's 43..128
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    pending.set(state, { verifier, expiresAt: clock.now() + STATE_TTL_MS, connectionId: connectionId ? String(connectionId) : null });

    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      // Always show the account chooser so each connection is an explicit choice of Google account.
      prompt: 'select_account consent',
      include_granted_scopes: 'true',
    }).toString();
    return { url: url.toString(), state };
  }

  /** Consume a state (single use). Returns its entry or throws OAUTH_STATE_INVALID. */
  function consumeState(state) {
    const entry = typeof state === 'string' ? pending.get(state) : undefined;
    if (entry) pending.delete(state);
    if (!entry || entry.expiresAt <= clock.now()) {
      throw new AppError('OAUTH_STATE_INVALID', 'This sign-in link is invalid, expired, or was already used. Start the connection again from the dashboard.', { status: 400 });
    }
    return entry;
  }

  /** Invalidate a state without exchanging (e.g. the user cancelled at Google). Never throws. */
  function discardState(state) {
    if (typeof state === 'string') pending.delete(state);
  }

  async function postForm(url, params) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function readJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  const expiresAtFrom = (expiresIn) => new Date(clock.now() + (Number(expiresIn) > 0 ? Number(expiresIn) : 3600) * 1000).toISOString();
  const describe = (body) => redactString([body?.error, body?.error_description].filter(Boolean).join(': ') || 'unknown error').slice(0, 300);

  async function exchangeCode({ code, state }) {
    const { verifier, connectionId } = consumeState(state); // state is validated before anything else
    requireConfigured();
    if (typeof code !== 'string' || !code) {
      throw new AppError('OAUTH_FAILED', 'Google did not return an authorization code.', { status: 400 });
    }
    let res;
    try {
      res = await postForm(GOOGLE_TOKEN_URL, {
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      });
    } catch {
      throw new AppError('OAUTH_FAILED', 'Could not reach Google to complete sign-in. Check your network and try again.', { status: 502 });
    }
    const body = await readJson(res);
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new AppError('OAUTH_FAILED', `Google rejected the sign-in (${describe(body)}). Start the connection again.`, { status: 502 });
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: expiresAtFrom(body.expires_in),
      scopes: parseScopes(body.scope),
      connectionId: connectionId ?? null,
    };
  }

  async function refresh(refreshToken) {
    if (!isConfigured()) throw new ChatProviderError('NOT_CONFIGURED', 'Google OAuth client is not configured.');
    if (!refreshToken) throw new ChatProviderError('AUTH_FAILED', 'No refresh token stored. Reconnect the account.');
    let res;
    try {
      res = await postForm(GOOGLE_TOKEN_URL, {
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
    } catch (err) {
      throw new ChatProviderError('NETWORK', `Could not reach Google to refresh the token (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
    }
    const body = await readJson(res);
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = body?.error === 'invalid_grant' || body?.error === 'unauthorized_client' || res.status === 401
        ? 'AUTH_FAILED'
        : body?.error === 'invalid_client' ? 'NOT_CONFIGURED' : 'UNKNOWN';
      throw new ChatProviderError(code, `Token refresh failed (${describe(body)}).`);
    }
    return {
      accessToken: body.access_token,
      expiresAt: expiresAtFrom(body.expires_in),
      ...(body.scope ? { scopes: parseScopes(body.scope) } : {}),
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    };
  }

  /** Best effort; revoking a refresh token revokes the whole grant. Resolves true on HTTP 200. */
  async function revoke(token) {
    if (!token) return false;
    try {
      const res = await postForm(GOOGLE_REVOKE_URL, { token });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    scopes,
    redirectUri,
    isConfigured,
    createAuthorizationUrl,
    exchangeCode,
    discardState,
    refresh,
    revoke,
    /** test/diagnostic helper: number of in-flight authorization requests */
    pendingCount: () => pending.size,
  };
}
