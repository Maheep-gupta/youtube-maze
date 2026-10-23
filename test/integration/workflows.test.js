// HTTP tests for multiple independently authorized accounts: /api/workflows, Refresh Status,
// per-account logs. Real Express app and services over in-memory SQLite; chat providers, fetch and
// the clock are mocked, so nothing is posted anywhere.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { testDb, testCipher, createFakeClock, createMockChatProvider, createMockAiProvider } from '../helpers.js';
import { loadConfig } from '../../src/config.js';
import { createContext } from '../../src/context.js';
import { createApp } from '../../src/app.js';

const HOST = '127.0.0.1:3000';
const ORIGIN = 'http://127.0.0.1:3000';
const VID_A = 'videoAAAAA1';
const VID_B = 'videoBBBBB1';
const url = (id) => `https://www.youtube.com/watch?v=${id}`;

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-wf-'));
  tmpDirs.push(dataDir);
  const config = loadConfig({
    dataDir, host: '127.0.0.1', port: 3000, chatProvider: 'test', tokenEncryptionKey: '',
    google: { clientId: '', clientSecret: '' }, ai: { baseUrl: 'https://ai.invalid/v1', model: 'm', apiKey: '' },
  });
  const clock = createFakeClock();
  const test = createMockChatProvider('test');
  test.streams[VID_A] = { liveChatId: 'chatA', title: 'Stream A' };
  test.streams[VID_B] = { liveChatId: 'chatB', title: 'Stream B' };
  const chatProviders = { youtube: createMockChatProvider('youtube'), test };
  const ctx = createContext(config, {
    db: testDb(), cipher: testCipher(), chatProviders, clock, aiProvider: createMockAiProvider(),
    fetch: async (u) => { throw new TypeError(`Network disabled in tests (attempted ${u})`); },
  });
  const app = createApp(ctx);
  let csrf;
  const withHost = (r) => r.set('Host', HOST);
  const a = {
    ctx, clock, provider: test,
    get: (u) => withHost(request(app).get(u)),
    async send(method, u, body) {
      csrf ??= (await a.get('/api/csrf')).body.token;
      const r = withHost(request(app)[method](u)).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body);
    },
    post: (u, body) => a.send('post', u, body),
    put: (u, body) => a.send('put', u, body),
    del: (u, body) => a.send('delete', u, body),
  };
  return a;
}

const expectStatus = (res, status) => assert.equal(res.status, status, `${res.req?.method} ${res.req?.path}: expected ${status}, got ${res.status}: ${res.text}`);
const expectError = (res, status, code) => {
  expectStatus(res, status);
  assert.equal(res.body?.error?.code, code, res.text);
};

/** Two Test Mode accounts with messages, each bound to its own stream. */
async function twoAccounts(a) {
  expectStatus(await a.post('/api/messages/load-samples', {}), 200);
  const ids = [];
  for (const label of ['Channel One', 'Channel Two']) {
    const res = await a.post('/api/connections/test', { label });
    expectStatus(res, 201);
    ids.push(res.body.id);
  }
  for (const [id, vid] of [[ids[0], VID_A], [ids[1], VID_B]]) {
    expectStatus(await a.put(`/api/workflows/${id}/settings`, { intervalSeconds: 30, minDelaySeconds: 10 }), 200);
    expectStatus(await a.post(`/api/workflows/${id}/stream/select`, { url: url(vid) }), 200);
  }
  return ids;
}

describe('workflows API: one workflow per account', () => {
  it('lists every account with settings, selection, status and the concurrency policy', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    const res = await a.get('/api/workflows');
    expectStatus(res, 200);
    assert.deepEqual(res.body.policy, { concurrentExternalAllowed: false });
    const byId = Object.fromEntries(res.body.items.map((i) => [i.connectionId, i]));
    assert.equal(res.body.items.length, 2);
    assert.deepEqual([byId[one].label, byId[one].connectionStatus], ['Channel One', 'connected']);
    assert.deepEqual([byId[two].label, byId[two].connectionStatus], ['Channel Two', 'connected']);
    assert.equal(byId[one].selection.videoId, VID_A);
    assert.equal(byId[two].selection.videoId, VID_B);
    assert.equal(byId[one].status.state, 'idle');
    assert.equal(byId[one].settings.intervalSeconds, 30);
    const single = await a.get(`/api/workflows/${two}`);
    expectStatus(single, 200);
    assert.equal(single.body.selection.videoId, VID_B);
    expectError(await a.get('/api/workflows/does-not-exist'), 404, 'NOT_FOUND');
  });

  it('settings are validated per account and unknown fields are rejected', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    expectError(await a.put(`/api/workflows/${one}/settings`, { intervalSeconds: 5 }), 400, 'VALIDATION_FAILED');
    expectError(await a.put(`/api/workflows/${one}/settings`, { connectionId: two }), 400, 'VALIDATION_FAILED');
    expectStatus(await a.put(`/api/workflows/${one}/settings`, { intervalSeconds: 120, reviewMode: true }), 200);
    assert.equal((await a.get(`/api/workflows/${one}`)).body.settings.reviewMode, true);
    assert.equal((await a.get(`/api/workflows/${two}`)).body.settings.reviewMode, false, 'other account untouched');
  });

  it('stream routes are pinned to the path account: a body connectionId is rejected', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    expectError(await a.post(`/api/workflows/${one}/stream/validate`, { url: url(VID_A), connectionId: two }), 400, 'VALIDATION_FAILED');
    const v = await a.post(`/api/workflows/${one}/stream/validate`, { url: `https://youtu.be/${VID_A}` });
    expectStatus(v, 200);
    assert.equal(v.body.connectionId, one);
    expectError(await a.post(`/api/workflows/${one}/stream/validate`, { url: 'https://example.com/watch?v=abc' }), 400, 'INVALID_STREAM_URL');
  });

  it('independent start/stop: both run, each posts only to its own stream; stop one keeps the other', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    expectStatus(await a.post(`/api/workflows/${one}/start`, {}), 200);
    expectStatus(await a.post(`/api/workflows/${two}/start`, {}), 200);
    await a.clock.advance(10_000);

    const sessions = a.ctx.db.prepare('SELECT connection_id, live_chat_id, messages_sent FROM sessions ORDER BY connection_id').all().map((r) => ({ ...r }));
    assert.deepEqual(sessions.map((s) => [s.connection_id, s.live_chat_id, s.messages_sent]).sort(), [[one, 'chatA', 1], [two, 'chatB', 1]].sort());
    assert.deepEqual(a.provider.sent.map((s) => s.liveChatId).sort(), ['chatA', 'chatB']);

    const conns = (await a.get('/api/connections')).body.items;
    assert.deepEqual(conns.map((c) => c.workflowState), ['running', 'running']);

    expectError(await a.post(`/api/workflows/${one}/stream/select`, { url: url(VID_B) }), 409, 'SCHEDULER_ACTIVE');
    expectStatus(await a.post(`/api/workflows/${one}/stop`, {}), 200);
    const states = (items, key) => Object.fromEntries(items.map((i) => [i.connectionId, key(i)]));
    assert.deepEqual(states((await a.get('/api/workflows')).body.items, (i) => i.status.state), { [one]: 'idle', [two]: 'running' });
    assert.deepEqual(states((await a.get('/api/overview')).body.workflows, (w) => w.state), { [one]: 'idle', [two]: 'running' });
    a.ctx.schedulers.stopAll('test end');
  });

  it('two accounts can not run on the same stream (STREAM_IN_USE)', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    expectStatus(await a.post(`/api/workflows/${two}/stream/select`, { url: url(VID_A) }), 200);
    expectStatus(await a.post(`/api/workflows/${one}/start`, {}), 200);
    expectError(await a.post(`/api/workflows/${two}/start`, {}), 409, 'STREAM_IN_USE');
    a.ctx.schedulers.stopAll('test end');
  });

  it('state-changing workflow calls need the CSRF token and same origin', async () => {
    const a = makeApp();
    const [one] = await twoAccounts(a);
    const noToken = await request(createApp(a.ctx)).post(`/api/workflows/${one}/start`).set('Host', HOST).set('Origin', ORIGIN).send({});
    assert.equal(noToken.status, 403);
    assert.equal(a.ctx.schedulers.engine(one).getStatus().state, 'idle');
  });

  it('removing an account stops its workflow and deletes it; the other keeps running', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    expectStatus(await a.post(`/api/workflows/${one}/start`, {}), 200);
    expectStatus(await a.post(`/api/workflows/${two}/start`, {}), 200);
    expectStatus(await a.del(`/api/connections/${one}`), 204);
    assert.equal(a.ctx.db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE connection_id = ?').get(one).n, 0);
    expectError(await a.get(`/api/workflows/${one}`), 404, 'NOT_FOUND');
    assert.equal((await a.get(`/api/workflows/${two}`)).body.status.state, 'running');
    a.ctx.schedulers.stopAll('test end');
  });
});

describe('accounts: Refresh Status over HTTP', () => {
  it('refresh succeeds for a connected account and fails with AUTH_FAILED once disconnected', async () => {
    const a = makeApp();
    const [one] = await twoAccounts(a);
    const ok = await a.post(`/api/connections/${one}/refresh`, {});
    expectStatus(ok, 200);
    assert.equal(ok.body.status, 'connected');
    expectStatus(await a.post(`/api/connections/${one}/disconnect`, {}), 200);
    expectError(await a.post(`/api/connections/${one}/refresh`, {}), 401, 'AUTH_FAILED');
  });
});

describe('per-account audit logs', () => {
  it('filters by account, exports the account id, and redacts credentials', async () => {
    const a = makeApp();
    const [one, two] = await twoAccounts(a);
    a.ctx.activity.log({ eventType: 'connection.error', level: 'error', connectionId: one, details: { message: 'Bearer ya29.leakedAccessToken123456 refresh_token=1//leakedRefreshToken0000000000' } });
    const listed = await a.get(`/api/logs?connectionId=${one}&limit=500`);
    expectStatus(listed, 200);
    assert.ok(listed.body.items.length > 0);
    assert.ok(listed.body.items.every((e) => e.connectionId === one));
    assert.ok(!(await a.get(`/api/logs?connectionId=${two}&limit=500`)).body.items.some((e) => e.connectionId === one));

    for (const format of ['json', 'csv']) {
      const res = await a.get(`/api/logs/export?format=${format}&connectionId=${one}`);
      expectStatus(res, 200);
      assert.ok(!res.text.includes('ya29.leakedAccessToken123456'), `${format} export leaked an access token`);
      assert.ok(!res.text.includes('1//leakedRefreshToken0000000000'), `${format} export leaked a refresh token`);
      assert.ok(res.text.includes(one));
      assert.ok(!res.text.includes(two), `${format} export contains another account`);
    }
  });
});
