import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, testCipher, createFakeClock, createMockFetch, createMockChatProvider } from '../helpers.js';
import { loadConfig } from '../../src/config.js';
import { createGoogleOAuth } from '../../src/services/googleOAuth.js';
import { createConnectionsService } from '../../src/services/connections.js';
import { createActivityService } from '../../src/services/activity.js';
import { createTestChatProvider } from '../../src/providers/chat/testProvider.js';

// Multiple independently authorized accounts: Refresh Status and per-account re-authorization.
// Google and YouTube are mocked; nothing leaves the process.

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const ACCESS_A = 'ya29.account-a-access-AAAA';
const ACCESS_B = 'ya29.account-b-access-BBBB';
const REFRESH = '1//refresh-token-RRRRRRRRRRRRRRRRRRRRRRRR';
const NEW_ACCESS = 'ya29.refreshed-access-NNNN';
const SECRETS = [ACCESS_A, ACCESS_B, REFRESH, NEW_ACCESS];

const config = () => loadConfig({ host: '127.0.0.1', port: 3000, chatProvider: 'test', google: { clientId: 'cid', clientSecret: 'GOCSPX-unit-test-secret' } });
const isToken = (u) => u === 'https://oauth2.googleapis.com/token';
const isRevoke = (u) => u === 'https://oauth2.googleapis.com/revoke';
const form = (init) => Object.fromEntries(new URLSearchParams(init.body));

function assertNoSecrets(value, label) {
  const s = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!s.includes(secret), `${label} leaked a token`);
}

function setup() {
  const db = testDb();
  const clock = createFakeClock();
  const activity = createActivityService({ db, clock });
  const state = {
    codeResponse: () => ({ json: { access_token: ACCESS_A, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE } }),
    refreshResponse: () => ({ json: { access_token: NEW_ACCESS, expires_in: 3600, scope: SCOPE } }),
  };
  const fetch = createMockFetch([
    { match: (u, init) => isToken(u) && form(init).grant_type === 'authorization_code', respond: () => state.codeResponse() },
    { match: (u, init) => isToken(u) && form(init).grant_type === 'refresh_token', respond: () => state.refreshResponse() },
    { match: isRevoke, respond: () => ({ json: {} }) },
  ]);
  const googleOAuth = createGoogleOAuth({ config: config(), fetch, clock });
  const youtube = createMockChatProvider('youtube');
  youtube.isTestMode = false;
  // The channel is decided by which access token Google issued.
  youtube.getAuthorizedChannel = async ({ accessToken }) => (accessToken === ACCESS_B
    ? { channelId: 'UCchannelB', title: 'Channel B' }
    : { channelId: 'UCchannelA', title: 'Channel A' });
  const connections = createConnectionsService({ db, cipher: testCipher(), activity, googleOAuth, chatProviders: { youtube, test: createTestChatProvider() }, clock });
  const events = [];
  connections.onAccountEvent((event, id, err) => events.push({ event, id, code: err?.code }));
  return { db, clock, fetch, googleOAuth, connections, activity, state, youtube, events };
}

async function authorize(env, { connectionId } = {}) {
  const { authUrl } = await env.connections.beginYouTubeAuth(connectionId ? { connectionId } : {});
  const url = new URL(authUrl);
  return { url, result: () => env.connections.completeYouTubeAuth({ code: 'code', state: url.searchParams.get('state') }) };
}

describe('accounts: several independent connections', () => {
  test('each Google sign-in shows the account chooser and creates its own connection (never merged)', async () => {
    const env = setup();
    const first = await authorize(env);
    assert.equal(first.url.searchParams.get('prompt'), 'select_account consent');
    const a = await first.result();
    env.state.codeResponse = () => ({ json: { access_token: ACCESS_B, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE } });
    const b = await (await authorize(env)).result();
    assert.notEqual(a.id, b.id);
    assert.deepEqual(env.connections.list().map((c) => c.externalId).sort(), ['UCchannelA', 'UCchannelB']);
    assertNoSecrets(env.connections.list(), 'list()');
  });

  test('reconnect of an account accepts only the same channel; a different channel is rejected and revoked', async () => {
    const env = setup();
    const a = await (await authorize(env)).result();
    const rowBefore = env.db.prepare('SELECT encrypted_tokens, status FROM account_connections WHERE id = ?').get(a.id);

    // The user picks the Google account of Channel B while reconnecting Channel A.
    env.state.codeResponse = () => ({ json: { access_token: ACCESS_B, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE } });
    const revokesBefore = env.fetch.calls.filter((c) => isRevoke(c.url)).length;
    const attempt = await authorize(env, { connectionId: a.id });
    await assert.rejects(attempt.result(), (err) => {
      assert.equal(err.code, 'ACCOUNT_MISMATCH');
      assert.equal(err.status, 409);
      assert.match(err.message, /different channel than this account/);
      return true;
    });
    assert.equal(env.fetch.calls.filter((c) => isRevoke(c.url)).length, revokesBefore + 1, 'the foreign grant is revoked');
    assert.equal(env.connections.list().length, 1, 'no new or merged connection');
    const rowAfter = env.db.prepare('SELECT encrypted_tokens, status FROM account_connections WHERE id = ?').get(a.id);
    assert.equal(rowAfter.encrypted_tokens, rowBefore.encrypted_tokens, 'existing tokens untouched');
    assert.equal(rowAfter.status, 'connected');

    // Same channel: accepted.
    env.state.codeResponse = () => ({ json: { access_token: ACCESS_A, refresh_token: REFRESH, expires_in: 3600, scope: SCOPE } });
    const ok = await (await authorize(env, { connectionId: a.id })).result();
    assert.equal(ok.id, a.id);
  });

  test('reconnect is only for YouTube accounts', async () => {
    const env = setup();
    const t = env.connections.addTestConnection({ label: 'Test' });
    await assert.rejects(env.connections.beginYouTubeAuth({ connectionId: t.id }), { code: 'NOT_SUPPORTED' });
  });
});

describe('accounts: Refresh Status', () => {
  test('success: refreshes the token, re-reads the channel, status connected, no tokens returned', async () => {
    const env = setup();
    const a = await (await authorize(env)).result();
    env.db.prepare("UPDATE account_connections SET status = 'error', last_error = 'old problem' WHERE id = ?").run(a.id);
    const refreshed = await env.connections.refresh(a.id);
    assert.equal(refreshed.status, 'connected');
    assert.equal(refreshed.lastError, null);
    assert.equal(refreshed.label, 'Channel A');
    assert.ok(env.fetch.calls.some((c) => isToken(c.url) && form(c.init).grant_type === 'refresh_token'));
    assertNoSecrets(refreshed, 'refresh()');
    assertNoSecrets(env.activity.exportAll({}), 'activity');
  });

  test('expired/revoked grant -> AUTH_FAILED, status error, account event emitted', async () => {
    const env = setup();
    const a = await (await authorize(env)).result();
    env.state.refreshResponse = () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    await assert.rejects(env.connections.refresh(a.id), (err) => err.code === 'AUTH_FAILED' && err.status === 401);
    const conn = env.connections.get(a.id);
    assert.equal(conn.status, 'error');
    assert.match(conn.lastError, /expired or revoked/);
    assert.ok(env.events.some((e) => e.event === 'auth_error' && e.id === a.id));
  });

  test('missing posting scope -> PERMISSION_DENIED (insufficientPermissions), status error', async () => {
    const env = setup();
    const a = await (await authorize(env)).result();
    env.state.refreshResponse = () => ({ json: { access_token: NEW_ACCESS, expires_in: 3600, scope: 'openid' } });
    await assert.rejects(env.connections.refresh(a.id), (err) => err.code === 'PERMISSION_DENIED' && err.status === 403 && /youtube\.force-ssl/.test(err.message));
    assert.equal(env.connections.get(a.id).status, 'error');
  });

  test('network failure keeps the status but records the reason', async () => {
    const env = setup();
    const a = await (await authorize(env)).result();
    env.state.refreshResponse = () => { throw new TypeError('socket hang up'); };
    await assert.rejects(env.connections.refresh(a.id), { code: 'NETWORK' });
    const conn = env.connections.get(a.id);
    assert.equal(conn.status, 'connected');
    assert.match(conn.lastError, /refresh/i);
  });

  test('disconnected account -> AUTH_FAILED without calling Google', async () => {
    const env = setup();
    const a = await (await authorize(env)).result();
    await env.connections.disconnect(a.id);
    const calls = env.fetch.calls.length;
    await assert.rejects(env.connections.refresh(a.id), { code: 'AUTH_FAILED' });
    assert.equal(env.fetch.calls.length, calls);
  });
});
