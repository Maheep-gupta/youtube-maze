import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMockFetch, createFakeClock } from '../helpers.js';
import { loadConfig } from '../../src/config.js';
import { createGoogleOAuth, parseScopes } from '../../src/services/googleOAuth.js';
import { AppError, ChatProviderError } from '../../src/errors.js';

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const config = (google = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret' }) =>
  loadConfig({ host: '127.0.0.1', port: 3000, google });

const isToken = (u) => u === 'https://oauth2.googleapis.com/token';
const form = (init) => Object.fromEntries(new URLSearchParams(init.body));

function setup(routes = [], google) {
  const clock = createFakeClock();
  const fetch = createMockFetch(routes);
  const oauth = createGoogleOAuth({ config: config(google), fetch, clock });
  return { clock, fetch, oauth };
}

describe('googleOAuth configuration', () => {
  test('isConfigured / scopes / redirectUri', () => {
    const { oauth } = setup();
    assert.equal(oauth.isConfigured(), true);
    assert.deepEqual(oauth.scopes, [SCOPE]);
    assert.equal(oauth.redirectUri, 'http://127.0.0.1:3000/oauth/google/callback');
    const unconfigured = setup([], { clientId: '', clientSecret: '' }).oauth;
    assert.equal(unconfigured.isConfigured(), false);
    assert.throws(() => unconfigured.createAuthorizationUrl(), { code: 'NOT_CONFIGURED' });
  });

  test('parseScopes splits the space-delimited scope string', () => {
    assert.deepEqual(parseScopes(`openid  ${SCOPE}`), ['openid', SCOPE]);
    assert.deepEqual(parseScopes(undefined), []);
  });
});

describe('createAuthorizationUrl', () => {
  test('includes PKCE S256 challenge and required params, never the secret', () => {
    const { oauth } = setup();
    const { url, state } = oauth.createAuthorizationUrl();
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    assert.equal(p.get('client_id'), 'cid.apps.googleusercontent.com');
    assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:3000/oauth/google/callback');
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('scope'), SCOPE);
    assert.equal(p.get('state'), state);
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.match(p.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(p.get('access_type'), 'offline');
    assert.equal(p.get('prompt'), 'select_account consent', 'account chooser every time');
    assert.equal(p.get('include_granted_scopes'), 'true');
    assert.ok(!url.includes('GOCSPX'));
    assert.ok(state.length >= 32);
  });

  test('each call produces a unique state', () => {
    const { oauth } = setup();
    assert.notEqual(oauth.createAuthorizationUrl().state, oauth.createAuthorizationUrl().state);
  });
});

describe('exchangeCode', () => {
  const tokenOk = { match: isToken, respond: () => ({ json: { access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3599, scope: SCOPE, token_type: 'Bearer' } }) };

  test('exchanges code with the PKCE verifier matching the challenge', async () => {
    const { oauth, fetch, clock } = setup([tokenOk]);
    const { url, state } = oauth.createAuthorizationUrl();
    const challenge = new URL(url).searchParams.get('code_challenge');
    const r = await oauth.exchangeCode({ code: 'auth-code', state });
    assert.deepEqual(r, {
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAt: new Date(clock.now() + 3599_000).toISOString(),
      scopes: [SCOPE],
      connectionId: null,
    });
    const body = form(fetch.calls[0].init);
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'auth-code');
    assert.equal(body.redirect_uri, 'http://127.0.0.1:3000/oauth/google/callback');
    assert.equal(crypto.createHash('sha256').update(body.code_verifier).digest('base64url'), challenge);
  });

  test('unknown state is rejected', async () => {
    const { oauth, fetch } = setup([tokenOk]);
    await assert.rejects(oauth.exchangeCode({ code: 'c', state: 'nope' }), (err) => err instanceof AppError && err.code === 'OAUTH_STATE_INVALID' && err.status === 400);
    await assert.rejects(oauth.exchangeCode({ code: 'c', state: undefined }), { code: 'OAUTH_STATE_INVALID' });
    assert.equal(fetch.calls.length, 0);
  });

  test('expired state (older than 10 minutes) is rejected', async () => {
    const { oauth, clock, fetch } = setup([tokenOk]);
    const { state } = oauth.createAuthorizationUrl();
    await clock.advance(10 * 60 * 1000 + 1);
    await assert.rejects(oauth.exchangeCode({ code: 'c', state }), { code: 'OAUTH_STATE_INVALID' });
    assert.equal(fetch.calls.length, 0);
  });

  test('state is single-use (reuse rejected), even if the first exchange failed', async () => {
    const { oauth } = setup([{ match: isToken, respond: () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } }) }]);
    const { state } = oauth.createAuthorizationUrl();
    await assert.rejects(oauth.exchangeCode({ code: 'c', state }), { code: 'OAUTH_FAILED' });
    await assert.rejects(oauth.exchangeCode({ code: 'c', state }), { code: 'OAUTH_STATE_INVALID' });
  });

  test('successful state cannot be reused', async () => {
    const { oauth } = setup([tokenOk]);
    const { state } = oauth.createAuthorizationUrl();
    await oauth.exchangeCode({ code: 'c', state });
    await assert.rejects(oauth.exchangeCode({ code: 'c', state }), { code: 'OAUTH_STATE_INVALID' });
  });

  test('discardState invalidates a pending state', async () => {
    const { oauth } = setup([tokenOk]);
    const { state } = oauth.createAuthorizationUrl();
    oauth.discardState(state);
    await assert.rejects(oauth.exchangeCode({ code: 'c', state }), { code: 'OAUTH_STATE_INVALID' });
  });

  test('token endpoint network failure -> OAUTH_FAILED without leaking the code', async () => {
    const clock = createFakeClock();
    const oauth = createGoogleOAuth({ config: config(), clock, fetch: async () => { throw new TypeError('fetch failed'); } });
    const { state } = oauth.createAuthorizationUrl();
    await assert.rejects(oauth.exchangeCode({ code: 'secret-code-value', state }), (err) => err.code === 'OAUTH_FAILED' && !err.message.includes('secret-code-value'));
  });
});

describe('refresh', () => {
  test('returns new access token and expiry', async () => {
    const { oauth, fetch, clock } = setup([{ match: isToken, respond: () => ({ json: { access_token: 'ya29.new', expires_in: 3600, scope: SCOPE } }) }]);
    const r = await oauth.refresh('1//refresh');
    assert.deepEqual(r, { accessToken: 'ya29.new', expiresAt: new Date(clock.now() + 3600_000).toISOString(), scopes: [SCOPE] });
    const body = form(fetch.calls[0].init);
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, '1//refresh');
  });

  test('invalid_grant -> ChatProviderError AUTH_FAILED (fatal)', async () => {
    const { oauth } = setup([{ match: isToken, respond: () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }) }]);
    await assert.rejects(oauth.refresh('1//refresh'), (err) => err instanceof ChatProviderError && err.code === 'AUTH_FAILED' && err.fatal === true);
  });

  test('network failure -> NETWORK', async () => {
    const oauth = createGoogleOAuth({ config: config(), clock: createFakeClock(), fetch: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(oauth.refresh('1//refresh'), { code: 'NETWORK' });
  });

  test('missing refresh token -> AUTH_FAILED', async () => {
    const { oauth } = setup();
    await assert.rejects(oauth.refresh(null), { code: 'AUTH_FAILED' });
  });
});

describe('revoke', () => {
  test('posts the token to the revoke endpoint and resolves boolean', async () => {
    const { oauth, fetch } = setup([{ match: (u) => u === 'https://oauth2.googleapis.com/revoke', respond: () => ({ json: {} }) }]);
    assert.equal(await oauth.revoke('1//refresh'), true);
    assert.equal(form(fetch.calls[0].init).token, '1//refresh');
    assert.ok(!fetch.calls[0].url.includes('1//refresh'), 'token in body, not URL');
  });
  test('best effort: failures resolve false', async () => {
    const oauth = createGoogleOAuth({ config: config(), clock: createFakeClock(), fetch: async () => { throw new TypeError('x'); } });
    assert.equal(await oauth.revoke('t'), false);
    assert.equal(await oauth.revoke(''), false);
  });
});
