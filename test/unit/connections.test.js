import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testDb, testCipher, createFakeClock, createMockFetch, createMockChatProvider, createMockAiProvider } from '../helpers.js';
import { loadConfig } from '../../src/config.js';
import { createGoogleOAuth } from '../../src/services/googleOAuth.js';
import { createConnectionsService } from '../../src/services/connections.js';
import { createActivityService } from '../../src/services/activity.js';
import { createTestChatProvider } from '../../src/providers/chat/testProvider.js';
import { ChatProviderError, AppError } from '../../src/errors.js';

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const ACCESS = 'ya29.first-access-token-AAAA';
const REFRESH = '1//refresh-token-BBBBBBBBBBBBBBBBBBBBBBBB';
const NEW_ACCESS = 'ya29.second-access-token-CCCC';
const SECRETS = [ACCESS, REFRESH, NEW_ACCESS];

const config = () => loadConfig({ host: '127.0.0.1', port: 3000, chatProvider: 'test', google: { clientId: 'cid', clientSecret: 'GOCSPX-unit-test-secret' } });
const isToken = (u) => u === 'https://oauth2.googleapis.com/token';
const isRevoke = (u) => u === 'https://oauth2.googleapis.com/revoke';
const form = (init) => Object.fromEntries(new URLSearchParams(init.body));

function assertNoSecrets(value, label) {
  const s = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!s.includes(secret), `${label} leaked a token`);
}

function setup({ tokenResponse, refreshResponse, scope = SCOPE } = {}) {
  const db = testDb();
  const cipher = testCipher();
  const clock = createFakeClock();
  const realActivity = createActivityService({ db });
  const rawLogs = [];
  const activity = { ...realActivity, log: (entry) => { rawLogs.push(entry); return realActivity.log(entry); } };
  const state = { refreshResponse: refreshResponse ?? (() => ({ json: { access_token: NEW_ACCESS, expires_in: 3600 } })) };
  const fetch = createMockFetch([
    {
      match: (u, init) => isToken(u) && form(init).grant_type === 'authorization_code',
      respond: tokenResponse ?? (() => ({ json: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope } })),
    },
    { match: (u, init) => isToken(u) && form(init).grant_type === 'refresh_token', respond: (...a) => state.refreshResponse(...a) },
    { match: isRevoke, respond: () => ({ json: {} }) },
  ]);
  const googleOAuth = createGoogleOAuth({ config: config(), fetch, clock });
  const youtube = createMockChatProvider('youtube');
  youtube.isTestMode = false;
  const chatProviders = { youtube, test: createTestChatProvider() };
  const connections = createConnectionsService({ db, cipher, activity, googleOAuth, chatProviders, clock });
  return { db, cipher, clock, fetch, googleOAuth, connections, rawLogs, activity: realActivity, state, youtube };
}

async function connectYouTube(env) {
  const { authUrl } = await env.connections.beginYouTubeAuth();
  const state = new URL(authUrl).searchParams.get('state');
  return env.connections.completeYouTubeAuth({ code: 'auth-code', state });
}

describe('connections: OAuth completion', () => {
  test('beginYouTubeAuth returns a Google URL; NOT_CONFIGURED without client credentials', async () => {
    const env = setup();
    const { authUrl } = await env.connections.beginYouTubeAuth();
    assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));

    const unconfigured = createConnectionsService({
      db: testDb(), cipher: testCipher(), activity: null, chatProviders: {},
      googleOAuth: createGoogleOAuth({ config: loadConfig({ google: { clientId: '', clientSecret: '' } }), fetch: createMockFetch([]) }),
    });
    await assert.rejects(unconfigured.beginYouTubeAuth(), (err) => err instanceof AppError && err.code === 'NOT_CONFIGURED' && err.status === 400 && /redirect URI/.test(err.hint));
  });

  test('stores tokens encrypted and returns a public shape without tokens', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    assert.equal(conn.provider, 'youtube');
    assert.equal(conn.label, 'Mock Channel');
    assert.equal(conn.externalId, 'UCmock');
    assert.equal(conn.status, 'connected');
    assert.deepEqual(conn.scopes, [SCOPE]);
    assert.equal(conn.isTestMode, false);
    assert.deepEqual(Object.keys(conn).sort(), ['createdAt', 'externalId', 'id', 'isTestMode', 'label', 'lastError', 'lastUsedAt', 'provider', 'scopes', 'status', 'updatedAt', 'workflowState']);
    assert.equal(conn.workflowState, 'idle');
    assertNoSecrets(conn, 'completeYouTubeAuth');
    assertNoSecrets(env.connections.list(), 'list()');
    assertNoSecrets(env.connections.get(conn.id), 'get()');

    const row = env.db.prepare('SELECT * FROM account_connections WHERE id = ?').get(conn.id);
    assertNoSecrets(row, 'raw DB row');
    assert.match(row.encrypted_tokens, /^v1:/);
    assert.deepEqual(env.cipher.decryptJson(row.encrypted_tokens), { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: row.token_expires_at });
  });

  test('activity log entries contain no secrets (raw input and stored)', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    await env.clock.advance(3600_000);
    await env.connections.getAuth(conn.id);
    await env.connections.disconnect(conn.id);
    assert.ok(env.rawLogs.some((l) => l.eventType === 'connection.added'));
    assert.ok(env.rawLogs.some((l) => l.eventType === 'connection.refreshed'));
    assert.ok(env.rawLogs.some((l) => l.eventType === 'connection.disconnected'));
    assertNoSecrets(env.rawLogs, 'activity.log input');
    assertNoSecrets(env.activity.exportAll({}), 'stored activity');
  });

  test('reconnecting the same channel upserts and keeps the old refresh token if Google omits it', async () => {
    let first = true;
    const env = setup({
      tokenResponse: () => {
        const json = first
          ? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE }
          : { access_token: NEW_ACCESS, expires_in: 3600, scope: SCOPE };
        first = false;
        return { json };
      },
    });
    const a = await connectYouTube(env);
    const b = await connectYouTube(env);
    assert.equal(a.id, b.id);
    assert.equal(env.connections.list().length, 1);
    const row = env.db.prepare('SELECT encrypted_tokens FROM account_connections WHERE id = ?').get(a.id);
    const tokens = env.cipher.decryptJson(row.encrypted_tokens);
    assert.equal(tokens.accessToken, NEW_ACCESS);
    assert.equal(tokens.refreshToken, REFRESH);
  });

  test('insufficient scope is flagged: status error, no tokens kept, grant revoked', async () => {
    const env = setup({ scope: 'https://www.googleapis.com/auth/youtube.readonly' });
    const conn = await connectYouTube(env);
    assert.equal(conn.status, 'error');
    assert.match(conn.lastError, /youtube\.force-ssl/);
    const row = env.db.prepare('SELECT encrypted_tokens FROM account_connections WHERE id = ?').get(conn.id);
    assert.equal(row.encrypted_tokens, null);
    assert.ok(env.fetch.calls.some((c) => isRevoke(c.url)));
    await assert.rejects(env.connections.getAuth(conn.id), { code: 'AUTH_FAILED' });
    assert.ok(env.rawLogs.some((l) => l.eventType === 'connection.error' && l.details.reason === 'insufficient_scope'));
  });

  test('access_denied is handled gracefully as OAUTH_DENIED and the state is discarded', async () => {
    const env = setup();
    const { authUrl } = await env.connections.beginYouTubeAuth();
    const state = new URL(authUrl).searchParams.get('state');
    await assert.rejects(env.connections.completeYouTubeAuth({ error: 'access_denied', state }), (err) => err instanceof AppError && err.code === 'OAUTH_DENIED' && err.status === 400);
    await assert.rejects(env.connections.completeYouTubeAuth({ code: 'x', state }), { code: 'OAUTH_STATE_INVALID' });
    assert.equal(env.connections.list().length, 0);
  });

  test('invalid / reused state is rejected and nothing is stored', async () => {
    const env = setup();
    await assert.rejects(env.connections.completeYouTubeAuth({ code: 'x', state: 'forged' }), { code: 'OAUTH_STATE_INVALID' });
    const conn = await connectYouTube(env);
    assert.ok(conn.id);
    assert.equal(env.connections.list().length, 1);
  });

  test('channel lookup failure revokes the fresh grant and stores nothing', async () => {
    const env = setup();
    env.youtube.getAuthorizedChannel = async () => { throw new ChatProviderError('PERMISSION_DENIED', 'no channel'); };
    await assert.rejects(connectYouTube(env), { code: 'PERMISSION_DENIED' });
    assert.equal(env.connections.list().length, 0);
    assert.ok(env.fetch.calls.some((c) => isRevoke(c.url)));
  });
});

describe('connections: getAuth / refresh', () => {
  test('returns the stored access token while it is fresh (no refresh call)', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    const auth = await env.connections.getAuth(conn.id);
    assert.equal(auth.accessToken, ACCESS);
    assert.equal(auth.channelId, 'UCmock');
    assert.ok(!env.fetch.calls.some((c) => isToken(c.url) && form(c.init).grant_type === 'refresh_token'));
  });

  test('refreshes within 60 s of expiry, re-encrypts, and preserves the refresh token', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    const before = env.db.prepare('SELECT encrypted_tokens FROM account_connections WHERE id = ?').get(conn.id).encrypted_tokens;
    await env.clock.advance(3600_000 - 59_000);
    const auth = await env.connections.getAuth(conn.id);
    assert.equal(auth.accessToken, NEW_ACCESS);
    const row = env.db.prepare('SELECT encrypted_tokens, token_expires_at FROM account_connections WHERE id = ?').get(conn.id);
    assert.notEqual(row.encrypted_tokens, before);
    assertNoSecrets(row, 'raw DB row after refresh');
    const tokens = env.cipher.decryptJson(row.encrypted_tokens);
    assert.deepEqual(tokens, { accessToken: NEW_ACCESS, refreshToken: REFRESH, expiresAt: new Date(env.clock.now() + 3600_000).toISOString() });
    assert.equal(row.token_expires_at, tokens.expiresAt);
    // Fresh again: no second refresh.
    const refreshCalls = () => env.fetch.calls.filter((c) => isToken(c.url) && form(c.init).grant_type === 'refresh_token').length;
    await env.connections.getAuth(conn.id);
    assert.equal(refreshCalls(), 1);
  });

  test('does not refresh when expiry is more than 60 s away', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    await env.clock.advance(3600_000 - 61_000);
    assert.equal((await env.connections.getAuth(conn.id)).accessToken, ACCESS);
  });

  test('invalid_grant on refresh -> AUTH_FAILED and connection status error', async () => {
    const env = setup({ refreshResponse: () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }) });
    const conn = await connectYouTube(env);
    await env.clock.advance(3600_000);
    await assert.rejects(env.connections.getAuth(conn.id), (err) => err instanceof ChatProviderError && err.code === 'AUTH_FAILED');
    const after = env.connections.get(conn.id);
    assert.equal(after.status, 'error');
    assert.match(after.lastError, /refresh failed/i);
    assertNoSecrets(after, 'get() after failed refresh');
    assertNoSecrets(env.rawLogs, 'activity after failed refresh');
  });

  test('transient refresh network error rethrows NETWORK without flipping status to error', async () => {
    const env = setup({ refreshResponse: () => { throw new TypeError('fetch failed'); } });
    const conn = await connectYouTube(env);
    await env.clock.advance(3600_000);
    await assert.rejects(env.connections.getAuth(conn.id), { code: 'NETWORK' });
    assert.equal(env.connections.get(conn.id).status, 'connected');
  });

  test('test connections return { test: true }', async () => {
    const env = setup();
    const conn = env.connections.addTestConnection({ label: 'Demo' });
    assert.equal(conn.isTestMode, true);
    assert.equal(conn.label, 'Demo');
    assert.deepEqual(await env.connections.getAuth(conn.id), { test: true });
  });

  test('unknown id -> 404', async () => {
    const env = setup();
    assert.throws(() => env.connections.get('missing'), { status: 404 });
    await assert.rejects(env.connections.getAuth('missing'), { status: 404 });
  });

  test('markError stores a sanitized message; auth errors set status error; markUsed clears it', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    env.connections.markError(conn.id, new ChatProviderError('NETWORK', `boom Bearer ${ACCESS}`));
    let c = env.connections.get(conn.id);
    assert.equal(c.status, 'connected');
    assert.ok(!c.lastError.includes(ACCESS));
    env.connections.markError(conn.id, new ChatProviderError('AUTH_FAILED', 'revoked'));
    assert.equal(env.connections.get(conn.id).status, 'error');
    env.connections.markUsed(conn.id);
    c = env.connections.get(conn.id);
    assert.equal(c.status, 'connected');
    assert.equal(c.lastError, null);
    assert.ok(c.lastUsedAt);
  });
});

describe('connections: disconnect / remove', () => {
  test('disconnect revokes the refresh token and clears stored tokens', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    const result = await env.connections.disconnect(conn.id);
    assert.equal(result.status, 'disconnected');
    const revoke = env.fetch.calls.find((c) => isRevoke(c.url));
    assert.equal(form(revoke.init).token, REFRESH);
    const row = env.db.prepare('SELECT encrypted_tokens, token_expires_at FROM account_connections WHERE id = ?').get(conn.id);
    assert.equal(row.encrypted_tokens, null);
    assert.equal(row.token_expires_at, null);
    await assert.rejects(env.connections.getAuth(conn.id), { code: 'AUTH_FAILED' });
  });

  test('remove deletes the row and clears scheduler_settings.connection_id', async () => {
    const env = setup();
    const conn = await connectYouTube(env);
    const other = env.connections.addTestConnection({ label: 'Other' });
    env.db.prepare('UPDATE scheduler_settings SET connection_id = ? WHERE id = 1').run(conn.id);
    await env.connections.remove(conn.id);
    assert.equal(env.db.prepare('SELECT connection_id FROM scheduler_settings WHERE id = 1').get().connection_id, null);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM account_connections WHERE id = ?').get(conn.id).n, 0);
    assert.ok(env.fetch.calls.some((c) => isRevoke(c.url)));
    assert.ok(env.rawLogs.some((l) => l.eventType === 'connection.removed'));
    // Settings pointing at another connection are untouched.
    env.db.prepare('UPDATE scheduler_settings SET connection_id = ? WHERE id = 1').run(other.id);
    const third = env.connections.addTestConnection({ label: 'Third' });
    await env.connections.remove(third.id);
    assert.equal(env.db.prepare('SELECT connection_id FROM scheduler_settings WHERE id = 1').get().connection_id, other.id);
  });

  test('cleanupAll revokes and deletes everything', async () => {
    const env = setup();
    await connectYouTube(env);
    env.connections.addTestConnection({});
    assert.equal(await env.connections.cleanupAll(), 2);
    assert.equal(env.connections.list().length, 0);
  });
});

describe('connections + oauth routes (HTTP)', () => {
  let ctx;
  let app;
  const HOST = '127.0.0.1:3000';
  const ORIGIN = 'http://127.0.0.1:3000';

  beforeEach(async () => {
    const { createContext } = await import('../../src/context.js');
    const { createApp } = await import('../../src/app.js');
    const youtube = createMockChatProvider('youtube');
    youtube.isTestMode = false;
    const fetch = createMockFetch([
      { match: isToken, respond: () => ({ json: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE } }) },
      { match: isRevoke, respond: () => ({ json: {} }) },
    ]);
    ctx = createContext(loadConfig({ host: '127.0.0.1', port: 3000, dbPath: ':memory:', chatProvider: 'test', google: { clientId: 'cid', clientSecret: 'GOCSPX-unit-test-secret' } }), {
      db: testDb(), cipher: testCipher(), fetch, clock: createFakeClock(),
      chatProviders: { youtube, test: createTestChatProvider() }, aiProvider: createMockAiProvider(),
    });
    ctx.csrfToken = 'csrf-test-token';
    app = createApp(ctx);
  });

  const post = (path) => request(app).post(path).set('Host', HOST).set('Origin', ORIGIN).set('X-CSRF-Token', 'csrf-test-token');

  test('full flow: start -> callback -> list -> check -> disconnect -> delete; no tokens in any response', async () => {
    const start = await post('/api/connections/youtube/start').send({}).expect(200);
    const state = new URL(start.body.authUrl).searchParams.get('state');

    const cb = await request(app).get('/oauth/google/callback').query({ code: 'abc', state, scope: SCOPE }).set('Host', HOST).expect(302);
    assert.equal(cb.headers.location, '/#connections');

    const list = await request(app).get('/api/connections').set('Host', HOST).expect(200);
    assert.equal(list.body.oauthConfigured, true);
    assert.equal(list.body.chatProvider, 'test');
    assert.equal(list.body.items.length, 1);
    const id = list.body.items[0].id;

    const check = await post(`/api/connections/${id}/check`).send({}).expect(200);
    assert.deepEqual(check.body, { broadcast: { title: 'Mock stream', broadcastId: 'b1' }, chat: { available: true } });

    const disc = await post(`/api/connections/${id}/disconnect`).send({}).expect(200);
    assert.equal(disc.body.status, 'disconnected');
    await request(app).delete(`/api/connections/${id}`).set('Host', HOST).set('Origin', ORIGIN).set('X-CSRF-Token', 'csrf-test-token').expect(204);

    for (const r of [start, list, check, disc]) assertNoSecrets(r.body, 'HTTP response');
  });

  test('callback with reused state renders an HTML error page', async () => {
    const res = await request(app).get('/oauth/google/callback').query({ code: 'abc', state: 'bogus' }).set('Host', HOST).expect(400);
    assert.match(res.headers['content-type'], /html/);
    assert.match(res.text, /invalid, expired, or was already used/);
  });

  test('callback with access_denied renders an HTML error page', async () => {
    const res = await request(app).get('/oauth/google/callback').query({ error: 'access_denied', state: 'x' }).set('Host', HOST).expect(400);
    assert.match(res.text, /cancelled or denied/);
  });

  test('test connection create validates body; bad id -> 400', async () => {
    const created = await post('/api/connections/test').send({ label: 'Demo' }).expect(201);
    assert.equal(created.body.isTestMode, true);
    await post('/api/connections/test').send({ label: 'Demo', extra: 1 }).expect(400);
    await post('/api/connections/not-a-uuid/check').send({}).expect(400);
    const check = await post(`/api/connections/${created.body.id}/check`).send({}).expect(200);
    assert.equal(check.body.broadcast.title, 'Test Mode stream (nothing is posted)');
  });

  test('check maps a provider auth failure to an error response and marks the connection', async () => {
    const created = await post('/api/connections/test').send({}).expect(201);
    ctx.chatProviders.test.getActiveBroadcast = async () => { throw new ChatProviderError('AUTH_FAILED', 'nope'); };
    const res = await post(`/api/connections/${created.body.id}/check`).send({}).expect(502);
    assert.equal(res.body.error.code, 'AUTH_FAILED');
    assert.equal(ctx.connections.get(created.body.id).status, 'error');
  });
});
