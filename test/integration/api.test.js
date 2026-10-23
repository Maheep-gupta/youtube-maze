// End-to-end HTTP tests: the real Express app + real services over an in-memory SQLite database.
// Everything external is mocked: chat providers, AI provider, fetch (throws), clock (fake).
import {
  testDb, testCipher, createFakeClock, createMockChatProvider, createMockAiProvider, createMockFetch,
  MOCK_VIDEO_ID, MOCK_STREAM_URL,
} from '../helpers.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { loadConfig } from '../../src/config.js';
import { createContext } from '../../src/context.js';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db/index.js';

const HOST = '127.0.0.1:3000';
const ORIGIN = 'http://127.0.0.1:3000';
const FAKE_AI_KEY = 'sk-integrationSecretKey0123456789';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const noNetwork = async (url) => { throw new TypeError(`Network disabled in tests (attempted ${url})`); };

/**
 * Build an isolated app. `ai` overrides config.ai; `aiProvider: null` uses the real
 * OpenAI-compatible provider wired to `fetch` (mocked).
 */
function makeApp({ rateLimit, ai = {}, aiProvider, fetch = noNetwork, db } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-int-'));
  tmpDirs.push(dataDir);
  const config = loadConfig({
    dataDir,
    host: '127.0.0.1',
    port: 3000,
    chatProvider: 'test',
    tokenEncryptionKey: '',
    google: { clientId: '', clientSecret: '' },
    ai: { baseUrl: 'https://ai.invalid/v1', model: 'mock-model', apiKey: '', ...ai },
    ...(rateLimit ? { rateLimit } : {}),
  });
  const clock = createFakeClock();
  const chatProviders = { youtube: createMockChatProvider('youtube'), test: createMockChatProvider('test') };
  const overrides = { db: db ?? testDb(), cipher: testCipher(), chatProviders, fetch, clock };
  if (aiProvider !== null) {
    overrides.aiProvider = aiProvider ?? createMockAiProvider({
      output: ['You are crushing it today!', 'Best stream of the week, easily.', 'Chat is so cozy tonight.'],
    });
  }
  const ctx = createContext(config, overrides);
  const app = createApp(ctx);
  let csrf;

  const withHost = (r) => r.set('Host', HOST);
  const api = {
    ctx, app, clock, chatProviders,
    get: (url) => withHost(request(app).get(url)),
    async csrf() {
      if (!csrf) csrf = (await api.get('/api/csrf').expect(200)).body.token;
      return csrf;
    },
    /** Same-origin, CSRF-authenticated request. Returns a promise with `.expect(status)`. */
    send(method, url, body) {
      const p = (async () => {
        const token = await api.csrf();
        const r = withHost(request(app)[method](url)).set('Origin', ORIGIN).set('X-CSRF-Token', token);
        return body === undefined ? r : r.send(body);
      })();
      p.expect = (status) => p.then((res) => {
        assert.equal(res.status, status, `${method.toUpperCase()} ${url}: expected ${status}, got ${res.status}: ${res.text}`);
        return res;
      });
      return p;
    },
    post: (url, body) => api.send('post', url, body),
    put: (url, body) => api.send('put', url, body),
    patch: (url, body) => api.send('patch', url, body),
    del: (url, body) => api.send('delete', url, body),
  };
  return api;
}

const assertError = (res, status, code) => {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, code, JSON.stringify(res.body));
  assert.equal(typeof res.body.error.message, 'string');
};

// ----------------------------------------------------------------------------------------------
describe('request guards (Host / Origin / CSRF)', () => {
  const a = makeApp();

  it('serves the CSRF token and health on GET', async () => {
    const csrf = await a.get('/api/csrf').expect(200);
    assert.ok(csrf.body.token.length >= 32);
    assert.equal(csrf.headers['cache-control'], 'no-store');
    const health = await a.get('/api/health').expect(200);
    assert.equal(health.body.ok, true);
    assert.match(health.body.version, /^\d+\.\d+\.\d+/);
  });

  it('sets security headers including CSP', async () => {
    const res = await a.get('/api/health');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const res = await request(a.app).get('/api/health').set('Host', 'evil.example:3000');
    assertError(res, 403, 'BAD_HOST');
  });

  it('accepts localhost:3000 as an alias host', async () => {
    await request(a.app).get('/api/health').set('Host', 'localhost:3000').expect(200);
  });

  it('rejects a state-changing request without Origin', async () => {
    const token = await a.csrf();
    const res = await request(a.app).post('/api/messages')
      .set('Host', HOST).set('X-CSRF-Token', token).send({ text: 'Hello there', category: 'compliments' });
    assertError(res, 403, 'BAD_ORIGIN');
  });

  it('rejects a cross-site Origin even with a valid token', async () => {
    const token = await a.csrf();
    const res = await request(a.app).post('/api/messages').set('Host', HOST)
      .set('Origin', 'https://evil.example').set('X-CSRF-Token', token)
      .send({ text: 'Hello there', category: 'compliments' });
    assertError(res, 403, 'BAD_ORIGIN');
  });

  it('rejects same-origin requests with a missing or wrong CSRF token', async () => {
    const missing = await request(a.app).post('/api/messages').set('Host', HOST).set('Origin', ORIGIN)
      .send({ text: 'Hello there', category: 'compliments' });
    assertError(missing, 403, 'BAD_CSRF');
    const wrong = await request(a.app).delete('/api/messages/1').set('Host', HOST).set('Origin', ORIGIN)
      .set('X-CSRF-Token', 'not-the-token');
    assertError(wrong, 403, 'BAD_CSRF');
    assert.equal(a.ctx.messages.list().total, 0, 'nothing was created');
  });

  it('returns JSON 404 for unknown /api routes (GET and POST)', async () => {
    assertError(await a.get('/api/does-not-exist'), 404, 'NOT_FOUND');
    assertError(await a.post('/api/nope/deeper', {}), 404, 'NOT_FOUND');
  });

  it('rejects malformed JSON bodies with 400 INVALID_JSON', async () => {
    const token = await a.csrf();
    const res = await request(a.app).post('/api/messages').set('Host', HOST).set('Origin', ORIGIN)
      .set('X-CSRF-Token', token).set('Content-Type', 'application/json').send('{"text": ');
    assertError(res, 400, 'INVALID_JSON');
  });
});

// ----------------------------------------------------------------------------------------------
describe('static files: path traversal and dotfiles', () => {
  const a = makeApp();
  const attempts = [
    '/..%2f..%2fpackage.json',
    '/%2e%2e/src/config.js',
    '/%2e%2e%2fsrc%2fconfig.js',
    '/js/..%2f..%2fpackage.json',
    '/..\\..\\package.json',
    '/.env',
    '/.env.example',
    '/%2eenv',
  ];
  for (const url of attempts) {
    it(`does not serve ${url}`, async () => {
      const res = await a.get(url);
      assert.notEqual(res.status, 200, `status ${res.status}`);
      const body = res.text ?? '';
      assert.doesNotMatch(body, /"name":\s*"live-chat-companion"/);
      assert.doesNotMatch(body, /export function loadConfig/);
      assert.doesNotMatch(body, /TOKEN_ENCRYPTION_KEY|GOOGLE_CLIENT_SECRET/);
    });
  }
});

// ----------------------------------------------------------------------------------------------
describe('messages API', () => {
  const a = makeApp();
  let id;

  it('creates a message (201) with the documented shape', async () => {
    const res = await a.post('/api/messages', { text: '  Great stream today!  ', category: 'compliments' }).expect(201);
    id = res.body.id;
    assert.equal(res.body.text, 'Great stream today!');
    assert.equal(res.body.category, 'compliments');
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.source, 'manual');
    assert.equal(res.body.timesSent, 0);
  });

  it('rejects an equivalent duplicate with 409 and the existing id', async () => {
    const res = await a.post('/api/messages', { text: 'great STREAM today', category: 'wholesome' });
    assertError(res, 409, 'DUPLICATE_MESSAGE');
    assert.equal(res.body.error.details.existingId, id);
  });

  it('rejects invalid input with 400', async () => {
    assertError(await a.post('/api/messages', { text: '', category: 'compliments' }), 400, 'INVALID_MESSAGE');
    assertError(await a.post('/api/messages', { text: 'x'.repeat(201), category: 'compliments' }), 400, 'INVALID_MESSAGE');
    assertError(await a.post('/api/messages', { text: 'visit https://spam.example', category: 'compliments' }), 400, 'INVALID_MESSAGE');
    assertError(await a.post('/api/messages', { text: 'Hello', category: 'nope' }), 400, 'VALIDATION_FAILED');
    assertError(await a.post('/api/messages', { text: 'Hello', category: 'compliments', extra: 1 }), 400, 'VALIDATION_FAILED');
    assertError(await a.patch('/api/messages/abc', { enabled: false }), 400, 'VALIDATION_FAILED');
  });

  it('checks duplicates without creating', async () => {
    const dup = await a.post('/api/messages/check-duplicate', { text: 'Great stream today' }).expect(200);
    assert.equal(dup.body.duplicate, true);
    assert.equal(dup.body.existing.id, id);
    const self = await a.post('/api/messages/check-duplicate', { text: 'Great stream today', excludeId: id }).expect(200);
    assert.equal(self.body.duplicate, false);
  });

  it('updates and deletes', async () => {
    await a.post('/api/messages', { text: 'Keep going, you got this', category: 'motivation' }).expect(201);
    const upd = await a.patch(`/api/messages/${id}`, { text: 'Great stream tonight!', enabled: false }).expect(200);
    assert.equal(upd.body.text, 'Great stream tonight!');
    assert.equal(upd.body.enabled, false);
    assertError(await a.patch(`/api/messages/${id}`, { text: 'keep going you got this' }), 409, 'DUPLICATE_MESSAGE');
    assertError(await a.patch('/api/messages/99999', { enabled: true }), 404, 'NOT_FOUND');

    const tmp = await a.post('/api/messages', { text: 'Temporary message', category: 'sarcasm' }).expect(201);
    await a.del(`/api/messages/${tmp.body.id}`).expect(204);
    assertError(await a.del(`/api/messages/${tmp.body.id}`), 404, 'NOT_FOUND');
  });

  it('lists with search, category and enabled filters', async () => {
    await a.post('/api/messages', { text: 'Wholesome vibes only', category: 'wholesome' }).expect(201);
    const all = await a.get('/api/messages').expect(200);
    assert.equal(all.body.total, 3);
    const q = await a.get('/api/messages?q=STREAM').expect(200);
    assert.deepEqual(q.body.items.map((m) => m.id), [id]);
    const cat = await a.get('/api/messages?category=wholesome').expect(200);
    assert.equal(cat.body.total, 1);
    assert.equal(cat.body.items[0].text, 'Wholesome vibes only');
    const disabled = await a.get('/api/messages?enabled=false').expect(200);
    assert.deepEqual(disabled.body.items.map((m) => m.id), [id]);
    const paged = await a.get('/api/messages?limit=1&offset=1').expect(200);
    assert.equal(paged.body.items.length, 1);
    assert.equal(paged.body.total, 3);
    assertError(await a.get('/api/messages?category=bogus'), 400, 'VALIDATION_FAILED');
  });

  it('reports stats', async () => {
    const res = await a.get('/api/messages/stats').expect(200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.enabled, 2);
    assert.deepEqual(res.body.byCategory.wholesome, { total: 1, enabled: 1 });
  });
});

// ----------------------------------------------------------------------------------------------
describe('import / export / load-samples', () => {
  const a = makeApp();

  it('imports the versioned format', async () => {
    const res = await a.post('/api/messages/import', {
      version: 1,
      messages: [
        { text: 'Versioned one', category: 'compliments' },
        { text: 'Versioned two', category: 'motivation', enabled: false },
        { text: 'Bad category', category: 'politics' },
      ],
    }).expect(200);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.skipped.length, 1);
    assert.match(res.body.skipped[0].reason, /category/i);
    const disabled = await a.get('/api/messages?enabled=false').expect(200);
    assert.equal(disabled.body.items[0].text, 'Versioned two');
    assert.equal(disabled.body.items[0].source, 'import');
  });

  it('imports a bare array of objects and a bare array of strings', async () => {
    const objs = await a.post('/api/messages/import', [{ text: 'Array object', category: 'sarcasm' }]).expect(200);
    assert.equal(objs.body.imported, 1);
    const strs = await a.post('/api/messages/import', ['Plain string one', 'Plain string two', 'versioned ONE']).expect(200);
    assert.equal(strs.body.imported, 2);
    assert.equal(strs.body.skipped[0].reason, 'Duplicate of an existing message.');
    const c = await a.get('/api/messages?q=Plain string').expect(200);
    assert.ok(c.body.items.every((m) => m.category === 'compliments'));
  });

  it('imports the legacy { "<category>": [...] } format', async () => {
    const res = await a.post('/api/messages/import', {
      witty_jokes: ['Legacy joke one', 'Legacy joke two'],
      wholesome: ['Legacy wholesome'],
      notacategory: ['Should be skipped'],
    }).expect(200);
    assert.equal(res.body.imported, 3);
    assert.equal(res.body.skipped.length, 1);
    const jokes = await a.get('/api/messages?category=witty_jokes').expect(200);
    assert.equal(jokes.body.total, 2);
  });

  it('rejects unsupported payloads with 400', async () => {
    assertError(await a.post('/api/messages/import', { compliments: 'not an array' }), 400, 'INVALID_IMPORT');
    assertError(await a.post('/api/messages/import', {}), 400, 'INVALID_IMPORT');
    const tooMany = Array.from({ length: 5001 }, (_, i) => `Message number ${i}`);
    assertError(await a.post('/api/messages/import', tooMany), 400, 'IMPORT_TOO_LARGE');
  });

  it('exports text/category/enabled only (no ids, tokens or secrets)', async () => {
    await a.post('/api/connections/test', { label: 'Exporter test' }).expect(201);
    const res = await a.get('/api/messages/export').expect(200);
    assert.match(res.headers['content-disposition'], /attachment; filename="messages-export\.json"/);
    const body = JSON.parse(res.text);
    assert.equal(body.version, 1);
    assert.ok(body.exportedAt);
    assert.equal(body.messages.length, 8);
    for (const m of body.messages) assert.deepEqual(Object.keys(m).sort(), ['category', 'enabled', 'text']);
    assert.deepEqual(Object.keys(body).sort(), ['exportedAt', 'messages', 'version']);
    assert.doesNotMatch(res.text, /"id"|token|secret|ya29\.|sk-|encrypted|Exporter test/i);
  });

  it('round-trips: an export re-imports as all duplicates', async () => {
    const exported = JSON.parse((await a.get('/api/messages/export')).text);
    const res = await a.post('/api/messages/import', exported).expect(200);
    assert.equal(res.body.imported, 0);
    assert.equal(res.body.skipped.length, exported.messages.length);
  });

  it('loads the bundled samples once (second load imports nothing)', async () => {
    const sample = JSON.parse(fs.readFileSync(new URL('../../samples/messages.sample.json', import.meta.url), 'utf8'));
    const first = await a.post('/api/messages/load-samples').expect(200);
    assert.ok(first.body.imported > 0);
    assert.equal(first.body.imported + first.body.skipped.length, sample.messages.length);
    const second = await a.post('/api/messages/load-samples').expect(200);
    assert.equal(second.body.imported, 0);
  });
});

// ----------------------------------------------------------------------------------------------
describe('drafts: generate -> approve -> library', () => {
  const a = makeApp();

  it('reports AI status without exposing a key', async () => {
    const res = await a.get('/api/drafts/ai-status').expect(200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.provider, 'mock-ai');
    assert.doesNotMatch(JSON.stringify(res.body), /key/i);
  });

  it('generates drafts with the mock AI, approves one, and it appears in messages', async () => {
    const gen = await a.post('/api/drafts/generate', { category: 'motivation', count: 3, source: 'ai' }).expect(200);
    assert.equal(gen.body.provider, 'mock-ai');
    assert.equal(gen.body.drafts.length, 3);
    assert.ok(gen.body.drafts.every((d) => d.status === 'pending' && d.category === 'motivation'));
    assert.equal(a.ctx.aiProvider.calls.length, 1);
    assert.equal(a.ctx.messages.list().total, 0, 'drafts are not library messages until approved');

    const pending = await a.get('/api/drafts').expect(200);
    assert.equal(pending.body.items.length, 3);

    const [first, second] = gen.body.drafts;
    const edited = await a.patch(`/api/drafts/${first.id}`, { text: 'You are crushing it today, keep going!' }).expect(200);
    assert.equal(edited.body.text, 'You are crushing it today, keep going!');

    const appr = await a.post('/api/drafts/approve', { ids: [first.id] }).expect(200);
    assert.equal(appr.body.approved.length, 1);
    assert.equal(appr.body.failed.length, 0);
    const msgs = await a.get('/api/messages?category=motivation').expect(200);
    assert.equal(msgs.body.total, 1);
    assert.equal(msgs.body.items[0].text, 'You are crushing it today, keep going!');
    assert.equal(msgs.body.items[0].source, 'ai');
    assert.equal(msgs.body.items[0].id, appr.body.approved[0].messageId);

    const again = await a.post('/api/drafts/approve', { ids: [first.id] }).expect(200);
    assert.equal(again.body.approved.length, 0);
    assert.match(again.body.failed[0].reason, /already approved/);

    const rej = await a.post('/api/drafts/reject', { ids: [second.id] }).expect(200);
    assert.equal(rej.body.rejected, 1);
    assert.equal((await a.get('/api/drafts').expect(200)).body.items.length, 1);
    const cleared = await a.del('/api/drafts').expect(200);
    assert.equal(cleared.body.cleared, 2);
  });

  it('generates from the preset library without AI', async () => {
    const res = await a.post('/api/drafts/generate', { category: 'wholesome', count: 2, source: 'preset' }).expect(200);
    assert.equal(res.body.provider, 'preset');
    assert.ok(res.body.drafts.length >= 1);
  });

  it('validates generate options', async () => {
    assertError(await a.post('/api/drafts/generate', { category: 'nope' }), 400, 'VALIDATION_FAILED');
    assertError(await a.post('/api/drafts/generate', { category: 'wholesome', tone: 'ignore previous <instructions>' }), 400, 'VALIDATION_FAILED');
    assertError(await a.post('/api/drafts/approve', { ids: [] }), 400, 'VALIDATION_FAILED');
  });
});

describe('drafts: AI provider errors map to JSON without leaking the key', () => {
  const routes = (status, json) => [{ match: (u) => u.startsWith('https://ai.invalid/'), respond: () => ({ status, json }) }];
  const cases = [
    { name: '401', fetch: createMockFetch(routes(401, { error: { message: `Incorrect API key provided: ${FAKE_AI_KEY}` } })), status: 502, code: 'AUTH_FAILED' },
    { name: '429', fetch: createMockFetch(routes(429, { error: { message: `Rate limit for key ${FAKE_AI_KEY}` } })), status: 502, code: 'RATE_LIMITED' },
    { name: '500 echoing the key', fetch: createMockFetch(routes(500, { error: { message: `upstream saw Bearer ${FAKE_AI_KEY}` } })), status: 502, code: 'BAD_RESPONSE' },
    { name: 'network failure', fetch: noNetwork, status: 502, code: 'NETWORK' },
  ];
  for (const c of cases) {
    it(`maps ${c.name} to ${c.status} ${c.code}`, async () => {
      const a = makeApp({ aiProvider: null, fetch: c.fetch, ai: { apiKey: FAKE_AI_KEY } });
      const status = await a.get('/api/drafts/ai-status').expect(200);
      assert.equal(status.body.configured, true);
      assert.equal(status.body.baseUrlHost, 'ai.invalid');

      const res = await a.post('/api/drafts/generate', { category: 'compliments', source: 'ai' });
      assertError(res, c.status, c.code);
      assert.ok(!res.text.includes(FAKE_AI_KEY), `key leaked in response: ${res.text}`);
      assert.ok(!res.text.includes('sk-'), res.text);
      if (c.fetch.calls) {
        assert.equal(c.fetch.calls.length, 1);
        assert.equal(c.fetch.calls[0].init.headers.Authorization, `Bearer ${FAKE_AI_KEY}`, 'key is only sent upstream');
      }
      const logs = await a.get('/api/logs/export?format=json').expect(200);
      assert.ok(!logs.text.includes(FAKE_AI_KEY), 'key leaked into activity log');
      assert.equal(a.ctx.db.prepare('SELECT COUNT(*) AS n FROM generated_drafts').get().n, 0);
    });
  }

  it('source=ai without a key is a 400 NOT_CONFIGURED; auto falls back to presets', async () => {
    const a = makeApp({ aiProvider: null });
    assertError(await a.post('/api/drafts/generate', { category: 'compliments', source: 'ai' }), 400, 'NOT_CONFIGURED');
    const auto = await a.post('/api/drafts/generate', { category: 'compliments' }).expect(200);
    assert.equal(auto.body.provider, 'preset');
  });
});

// ----------------------------------------------------------------------------------------------
describe('scheduler end to end (test connection, fake clock)', () => {
  const a = makeApp();
  const mock = a.chatProviders.test;
  let connectionId;

  before(async () => {
    await a.post('/api/messages/import', ['Scheduler message A', 'Scheduler message B', 'Scheduler message C']).expect(200);
  });

  it('adds a test connection (no tokens in the response)', async () => {
    const res = await a.post('/api/connections/test', { label: 'My test channel' }).expect(201);
    connectionId = res.body.id;
    assert.equal(res.body.provider, 'test');
    assert.equal(res.body.isTestMode, true);
    assert.equal(res.body.status, 'connected');
    assert.doesNotMatch(res.text, /token/i);
    const list = await a.get('/api/connections').expect(200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.oauthConfigured, false);
    assert.equal(list.body.chatProvider, 'test');
    const check = await a.post(`/api/connections/${connectionId}/check`).expect(200);
    assert.deepEqual(check.body, { broadcast: { title: 'Mock stream', broadcastId: 'b1' }, chat: { available: true } });
  });

  it('refuses to start before a connection is selected', async () => {
    assertError(await a.post('/api/scheduler/start', {}), 400, 'NO_CONNECTION');
  });

  it('validates and saves settings', async () => {
    assertError(await a.put('/api/scheduler/settings', { intervalSeconds: 5 }), 400, 'VALIDATION_FAILED');
    assertError(await a.put('/api/scheduler/settings', { intervalSeconds: 60, minDelaySeconds: 120 }), 400, 'INVALID_SETTINGS');
    assertError(await a.put('/api/scheduler/settings', { connectionId: '00000000-0000-4000-8000-000000000000' }), 404, 'NOT_FOUND');
    const res = await a.put('/api/scheduler/settings', {
      intervalSeconds: 60, minDelaySeconds: 30, maxMessagesPerSession: 10, dailyLimit: 50, connectionId,
    }).expect(200);
    assert.equal(res.body.intervalSeconds, 60);
    assert.equal(res.body.connectionId, connectionId);
    assert.deepEqual((await a.get('/api/scheduler/settings').expect(200)).body, res.body);
  });

  it('refuses to start until a livestream is selected, then selects one', async () => {
    assertError(await a.post('/api/scheduler/start', {}), 400, 'NO_STREAM_SELECTED');
    const sel = await a.post('/api/stream/select', { url: MOCK_STREAM_URL }).expect(200);
    assert.equal(sel.body.selection.videoId, MOCK_VIDEO_ID);
    assert.equal(sel.body.selection.connectionId, connectionId);
  });

  it('starts, and counts a message as sent only after the provider confirms it', async () => {
    const started = await a.post('/api/scheduler/start', {}).expect(200);
    assert.equal(started.body.state, 'running');
    assert.equal(started.body.session.status, 'running');
    assert.equal(started.body.session.broadcastTitle, 'Mock stream');
    assert.equal(started.body.msUntilNext, 10_000, 'first tick at min(10 s, interval)');
    assert.equal(started.body.today.sent, 0);
    assertError(await a.post('/api/scheduler/start', {}), 409, 'ALREADY_RUNNING');

    // Hold the provider's send: the tick is in flight but nothing is confirmed yet.
    let release;
    mock.hold = new Promise((r) => { release = r; });
    const advancing = a.clock.advance(10_000);
    await new Promise((r) => setImmediate(r));
    const during = await a.get('/api/scheduler/status').expect(200);
    assert.equal(during.body.inFlight, true);
    assert.equal(during.body.session.messagesSent, 0);
    assert.equal(during.body.today.sent, 0);
    assert.equal(mock.sent.length, 0);

    mock.hold = null;
    release();
    await advancing;
    const after1 = await a.get('/api/scheduler/status').expect(200);
    assert.equal(after1.body.inFlight, false);
    assert.equal(mock.sent.length, 1);
    assert.equal(mock.sent[0].liveChatId, 'chat1');
    assert.equal(after1.body.session.messagesSent, 1);
    assert.equal(after1.body.today.sent, 1);
    assert.equal(after1.body.msUntilNext, 60_000);

    const sentLog = await a.get('/api/logs?group=messages').expect(200);
    const sentEntry = sentLog.body.items.find((e) => e.eventType === 'message.sent');
    assert.equal(sentEntry.level, 'success');
    assert.equal(sentEntry.details.providerMessageId, 'm1');
  });

  it('does not count a failed send', async () => {
    mock.failNext('NETWORK', 'mock network blip');
    await a.clock.advance(60_000);
    const st = await a.get('/api/scheduler/status').expect(200);
    assert.equal(st.body.state, 'running', 'non-fatal error keeps running');
    assert.equal(st.body.session.messagesSent, 1);
    assert.equal(st.body.session.messagesFailed, 1);
    assert.equal(st.body.today.sent, 1);
    const failed = await a.get('/api/logs?level=error').expect(200);
    assert.ok(failed.body.items.some((e) => e.eventType === 'message.failed' && e.outcome === 'NETWORK'));
  });

  it('pauses (no sends while paused) and resumes', async () => {
    const paused = await a.post('/api/scheduler/pause', {}).expect(200);
    assert.equal(paused.body.state, 'paused');
    assert.equal(paused.body.nextRunAt, null);
    await a.clock.advance(10 * 60_000);
    assert.equal(mock.sent.length, 1, 'nothing sent while paused');

    const resumed = await a.post('/api/scheduler/resume', {}).expect(200);
    assert.equal(resumed.body.state, 'running');
    await a.clock.advance(1);
    const st = await a.get('/api/scheduler/status').expect(200);
    assert.equal(mock.sent.length, 2);
    assert.equal(st.body.session.messagesSent, 2);
    assert.notEqual(mock.sent[1].text, mock.sent[0].text, 'no consecutive repeat');
    assertError(await a.post('/api/scheduler/pause', { extra: true }), 400, 'VALIDATION_FAILED');
  });

  it('stops and finalizes the session; stop is idempotent', async () => {
    const stopped = await a.post('/api/scheduler/stop', {}).expect(200);
    assert.equal(stopped.body.state, 'idle');
    assert.equal(stopped.body.session.status, 'stopped');
    assert.equal(stopped.body.session.stopReason, 'Stopped by user');
    assert.equal(a.clock.pending(), 0, 'no timers left behind');
    await a.post('/api/scheduler/stop', {}).expect(200);
    assertError(await a.post('/api/scheduler/pause', {}), 409, 'NOT_RUNNING');

    const sched = await a.get('/api/logs?group=scheduler').expect(200);
    const types = sched.body.items.map((e) => e.eventType);
    for (const t of ['scheduler.start', 'scheduler.pause', 'scheduler.resume', 'scheduler.stop']) assert.ok(types.includes(t), t);
    assert.ok(types.every((t) => t.startsWith('scheduler.') || t.startsWith('stream.')));
  });

  it('refuses to start when the channel is not live (409 NOT_LIVE)', async () => {
    mock.live = false;
    try {
      const res = await a.post('/api/scheduler/start', {});
      assertError(res, 409, 'NOT_LIVE');
      assert.ok(res.body.error.hint);
      const st = await a.get('/api/scheduler/status').expect(200);
      assert.equal(st.body.state, 'idle');
    } finally {
      mock.live = true;
    }
  });

  it('refuses to start when live chat is unavailable (409 CHAT_UNAVAILABLE)', async () => {
    mock.chatAvailable = false;
    try {
      assertError(await a.post('/api/scheduler/start', {}), 409, 'CHAT_UNAVAILABLE');
    } finally {
      mock.chatAvailable = true;
    }
  });

  it('stops the session when the stream ends mid-session', async () => {
    await a.post('/api/scheduler/start', {}).expect(200);
    mock.live = false;
    try {
      await a.clock.advance(10_000);
      const st = await a.get('/api/scheduler/status').expect(200);
      assert.equal(st.body.state, 'idle');
      assert.equal(st.body.session.status, 'error');
      assert.match(st.body.session.stopReason, /NOT_LIVE/);
    } finally {
      mock.live = true;
    }
  });

  it('overview aggregates everything without secrets', async () => {
    const res = await a.get('/api/overview').expect(200);
    assert.equal(res.body.app.testMode, true);
    assert.equal(res.body.connections.total, 1);
    assert.equal(res.body.scheduler.state, 'idle');
    assert.equal(res.body.messages.total, 3);
    assert.ok(Array.isArray(res.body.recentActivity));
    assert.doesNotMatch(res.text, /encrypted|refresh_?token|access_?token/i);
  });
});

// ----------------------------------------------------------------------------------------------
describe('logs: filters and redacted exports', () => {
  const a = makeApp();
  const GOOGLE = 'ya29.a0AfH6SMBxFAKEgoogleAccessToken1234567890';
  const OPENAI = 'sk-proj-FAKEopenAIkey1234567890abcdef';

  before(() => {
    // Via the service (redacted on write)...
    a.ctx.activity.log({
      eventType: 'scheduler.error', level: 'error',
      details: { note: `upstream said Bearer ${GOOGLE} and ${OPENAI}`, accessToken: 'plain-access-value', nested: { refresh_token: '1//FAKErefreshTokenValue1234567890' } },
    });
    // ...and a raw row as if written by an older version without redaction (export must re-redact).
    a.ctx.db.prepare(`INSERT INTO activity_logs (ts, event_type, level, outcome, details) VALUES (?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), 'scheduler.error', 'warning', `token ${GOOGLE}`,
        JSON.stringify({ message: `=cmd|' /C calc'!A0 ${GOOGLE} ${OPENAI}`, api_key: OPENAI }));
    a.ctx.activity.log({ eventType: 'message.created', level: 'info', details: { source: 'manual' } });
    a.ctx.activity.log({ eventType: 'connection.added', level: 'success', provider: 'test' });
  });

  const assertClean = (text) => {
    for (const secret of [GOOGLE, OPENAI, 'ya29.', 'sk-proj', 'plain-access-value', '1//FAKE']) {
      assert.ok(!text.includes(secret), `export contains ${secret}`);
    }
  };

  it('filters by level and by group', async () => {
    const errors = await a.get('/api/logs?level=error').expect(200);
    assert.ok(errors.body.items.length >= 1);
    assert.ok(errors.body.items.every((e) => e.level === 'error'));
    const sched = await a.get('/api/logs?group=scheduler').expect(200);
    assert.equal(sched.body.items.length, 2);
    assert.ok(sched.body.items.every((e) => e.eventType.startsWith('scheduler.')));
    const both = await a.get('/api/logs?group=scheduler&level=warning').expect(200);
    assert.equal(both.body.items.length, 1);
    assertError(await a.get('/api/logs?level=debug'), 400, 'VALIDATION_FAILED');
    assertError(await a.get('/api/logs?group=everything'), 400, 'VALIDATION_FAILED');
  });

  it('paginates with limit/beforeId', async () => {
    const page1 = await a.get('/api/logs?limit=2').expect(200);
    assert.equal(page1.body.items.length, 2);
    assert.ok(page1.body.nextBeforeId);
    const page2 = await a.get(`/api/logs?limit=2&beforeId=${page1.body.nextBeforeId}`).expect(200);
    assert.ok(page2.body.items.every((e) => e.id < page1.body.nextBeforeId));
  });

  it('list responses are redacted, including raw legacy rows', async () => {
    assertClean((await a.get('/api/logs?limit=500').expect(200)).text);
  });

  it('entries written through the activity service are redacted at rest and in list responses', async () => {
    // level=error selects only the service-written entry.
    const res = await a.get('/api/logs?level=error').expect(200);
    assert.equal(res.body.items.length, 1);
    assertClean(res.text);
    assert.equal(res.body.items[0].details.accessToken, '[REDACTED]');
  });

  it('JSON export is an attachment and redacted', async () => {
    const res = await a.get('/api/logs/export?format=json').expect(200);
    assert.match(res.headers['content-disposition'], /attachment; filename="activity-\d{4}-\d{2}-\d{2}\.json"/);
    assertClean(res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.items.length, 4);
    const filtered = JSON.parse((await a.get('/api/logs/export?format=json&group=scheduler&level=error').expect(200)).text);
    assert.equal(filtered.items.length, 1);
  });

  it('CSV export is an attachment, redacted, and formula-safe', async () => {
    const res = await a.get('/api/logs/export?format=csv').expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="activity-\d{4}-\d{2}-\d{2}\.csv"/);
    assertClean(res.text);
    const lines = res.text.trim().split('\r\n');
    assert.equal(lines[0], 'id,ts,eventType,level,sessionId,connectionId,provider,category,outcome,messageId,details');
    assert.equal(lines.length, 5);
    assert.ok(!/(^|,)"=/.test(res.text), 'no cell starts with a formula');
  });

  it('clearing logs requires confirm: true', async () => {
    assertError(await a.del('/api/logs', {}), 400, 'VALIDATION_FAILED');
    assertError(await a.del('/api/logs', { confirm: 'yes' }), 400, 'VALIDATION_FAILED');
    const res = await a.del('/api/logs', { confirm: true }).expect(200);
    assert.equal(res.body.cleared, 4);
  });
});

// ----------------------------------------------------------------------------------------------
describe('system cleanup', () => {
  const a = makeApp();

  before(async () => {
    await a.post('/api/messages/import', ['Cleanup message one', 'Cleanup message two']).expect(200);
    const conn = await a.post('/api/connections/test', {}).expect(201);
    await a.put('/api/scheduler/settings', { connectionId: conn.body.id }).expect(200);
    await a.post('/api/stream/select', { url: MOCK_STREAM_URL }).expect(200);
    await a.post('/api/scheduler/start', {}).expect(200);
    await a.clock.advance(10_000);
    await a.post('/api/drafts/generate', { category: 'compliments', source: 'preset', count: 2 }).expect(200);
  });

  it('requires confirm: "DELETE"', async () => {
    assertError(await a.post('/api/system/cleanup', {}), 400, 'VALIDATION_FAILED');
    assertError(await a.post('/api/system/cleanup', { confirm: 'delete' }), 400, 'VALIDATION_FAILED');
    assertError(await a.post('/api/system/cleanup', { confirm: true }), 400, 'VALIDATION_FAILED');
    assert.equal((await a.get('/api/connections')).body.items.length, 1, 'nothing removed');
  });

  it('stops the scheduler and wipes connections, logs, drafts, sessions and the send ledger', async () => {
    assert.equal((await a.get('/api/scheduler/status')).body.state, 'running');
    const res = await a.post('/api/system/cleanup', { confirm: 'DELETE' }).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.removed.connections, 1);
    assert.equal(res.body.removed.sessions, 1);
    assert.equal(res.body.removed.sendLedger, 1);
    assert.ok(res.body.removed.logs > 0);
    assert.ok(res.body.removed.drafts > 0);
    assert.equal(res.body.removed.messages, undefined, 'messages kept by default');

    const status = (await a.get('/api/scheduler/status').expect(200)).body;
    assert.equal(status.state, 'idle');
    assert.equal(status.session, null);
    assert.equal(status.settings.connectionId, null);
    assert.equal(status.today.sent, 0);
    assert.equal(a.clock.pending(), 0);
    assert.deepEqual((await a.get('/api/connections').expect(200)).body.items, []);
    const logs = (await a.get('/api/logs').expect(200)).body.items;
    assert.deepEqual(logs.map((e) => e.eventType), ['data.cleanup']);
    assert.equal((await a.get('/api/drafts?status=all').expect(200)).body.items.length, 0);
    assert.equal((await a.get('/api/messages').expect(200)).body.total, 2);
  });

  it('includeMessages also wipes the library', async () => {
    const res = await a.post('/api/system/cleanup', { confirm: 'DELETE', includeMessages: true }).expect(200);
    assert.equal(res.body.removed.messages, 2);
    assert.equal((await a.get('/api/messages').expect(200)).body.total, 0);
  });
});

// ----------------------------------------------------------------------------------------------
describe('OAuth endpoints without Google configuration', () => {
  const a = makeApp();

  it('youtube/start returns 400 NOT_CONFIGURED with a setup hint', async () => {
    const res = await a.post('/api/connections/youtube/start', {});
    assertError(res, 400, 'NOT_CONFIGURED');
    assert.match(res.body.error.hint, /http:\/\/127\.0\.0\.1:3000\/oauth\/google\/callback/);
  });

  it('callback with error=access_denied renders an HTML error page', async () => {
    const res = await a.get('/oauth/google/callback?error=access_denied&state=abc');
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /cancelled or denied/);
  });

  it('callback with an unknown state is rejected', async () => {
    const res = await a.get('/oauth/google/callback?code=fake-code&state=never-issued');
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.text, /fake-code/);
  });
});

// ----------------------------------------------------------------------------------------------
describe('rate limiting', () => {
  it('returns 429 JSON once the /api limit is exceeded', async () => {
    const a = makeApp({ rateLimit: { max: 5 } });
    for (let i = 0; i < 5; i++) await a.get('/api/health').expect(200);
    const res = await a.get('/api/health');
    assertError(res, 429, 'RATE_LIMITED');
    assert.ok(res.headers.ratelimit || res.headers['ratelimit-policy'], 'standard RateLimit headers present');
  });

  it('applies the strict limiter (10/window) to AI generation', async () => {
    const a = makeApp();
    for (let i = 0; i < 10; i++) {
      const r = await a.post('/api/drafts/generate', { category: 'nope' });
      assert.equal(r.status, 400);
    }
    assertError(await a.post('/api/drafts/generate', { category: 'compliments' }), 429, 'RATE_LIMITED');
  });
});

// ----------------------------------------------------------------------------------------------
// Livestream selection. Each block uses its own app: validate/select share the 10/min strict limiter.
async function withConnection(a) {
  const conn = await a.post('/api/connections/test', {}).expect(201);
  await a.put('/api/scheduler/settings', { connectionId: conn.body.id }).expect(200);
  return conn.body.id;
}
const urlFor = (id) => `https://www.youtube.com/watch?v=${id}`;

describe('stream: validate (status mapping, nothing persisted)', () => {
  const a = makeApp();
  const mock = a.chatProviders.test;
  let connectionId;

  before(async () => { connectionId = await withConnection(a); });

  it('starts with no selection', async () => {
    assert.deepEqual((await a.get('/api/stream').expect(200)).body, { selection: null, locked: false });
  });

  it('rejects malformed and unrelated URLs with 400 INVALID_STREAM_URL', async () => {
    assertError(await a.post('/api/stream/validate', { url: 'https://youtube.com/watch?v=short' }), 400, 'INVALID_STREAM_URL');
    assertError(await a.post('/api/stream/validate', { url: `https://evil.example/watch?v=${MOCK_VIDEO_ID}` }), 400, 'INVALID_STREAM_URL');
  });

  it('live stream with chat -> live, canConnect; accepts youtu.be and /live/ forms', async () => {
    const res = await a.post('/api/stream/validate', { url: `https://youtu.be/${MOCK_VIDEO_ID}` }).expect(200);
    assert.equal(res.body.videoId, MOCK_VIDEO_ID);
    assert.equal(res.body.url, MOCK_STREAM_URL);
    assert.equal(res.body.status, 'live');
    assert.equal(res.body.canConnect, true);
    assert.equal(res.body.chatAvailable, true);
    assert.equal(res.body.title, 'Mock stream');
    assert.equal(res.body.channelTitle, 'Mock Channel');
    assert.equal(res.body.connectionId, connectionId);
    assert.deepEqual(mock.streamCalls.at(-1), { videoId: MOCK_VIDEO_ID, checkChat: true });
    const live = await a.post('/api/stream/validate', { url: `https://www.youtube.com/live/${MOCK_VIDEO_ID}` }).expect(200);
    assert.equal(live.body.videoId, MOCK_VIDEO_ID);
    assert.equal((await a.get('/api/stream')).body.selection, null, 'validate never persists');
  });

  it('upcoming -> valid; ended -> offline; live without chat -> not connectable', async () => {
    mock.streams.upcoming001 = { status: 'upcoming' };
    mock.streams.ended000001 = { status: 'ended' };
    mock.streams.nochat00001 = { chatAvailable: false, chatReason: 'Live chat is disabled' };
    const up = await a.post('/api/stream/validate', { url: urlFor('upcoming001') }).expect(200);
    assert.equal(up.body.status, 'valid');
    assert.equal(up.body.canConnect, true);
    const ended = await a.post('/api/stream/validate', { url: urlFor('ended000001') }).expect(200);
    assert.equal(ended.body.status, 'offline');
    assert.equal(ended.body.canConnect, false);
    const noChat = await a.post('/api/stream/validate', { url: urlFor('nochat00001') }).expect(200);
    assert.equal(noChat.body.status, 'live');
    assert.equal(noChat.body.chatAvailable, false);
    assert.equal(noChat.body.canConnect, false);
    assert.match(noChat.body.message, /chat/i);
  });
});

describe('stream: validate without a saved sending account', () => {
  const a = makeApp();

  it('uses the only connected account, but refuses to guess among several', async () => {
    const first = (await a.post('/api/connections/test', {}).expect(201)).body.id;
    const res = await a.post('/api/stream/validate', { url: MOCK_STREAM_URL }).expect(200);
    assert.equal(res.body.connectionId, first);
    await a.post('/api/connections/test', { label: 'Second' }).expect(201);
    assertError(await a.post('/api/stream/validate', { url: MOCK_STREAM_URL }), 400, 'NO_CONNECTION');
  });
});

describe('stream: validate errors (permissions, missing connection, API failures)', () => {
  const a = makeApp();
  const mock = a.chatProviders.test;

  it('needs a sending account first (400 NO_CONNECTION)', async () => {
    assertError(await a.post('/api/stream/validate', { url: MOCK_STREAM_URL }), 400, 'NO_CONNECTION');
    await withConnection(a);
  });

  it('rejects unknown body fields', async () => {
    assertError(await a.post('/api/stream/validate', { url: MOCK_STREAM_URL, extra: 1 }), 400, 'VALIDATION_FAILED');
  });

  it('maps provider errors to actionable JSON errors', async () => {
    for (const [code, status] of [['STREAM_NOT_FOUND', 404], ['PERMISSION_DENIED', 403], ['AUTH_FAILED', 400], ['QUOTA_EXCEEDED', 429], ['NETWORK', 502]]) {
      mock.streams[MOCK_VIDEO_ID] = { error: code, message: `mock ${code} message` };
      const res = await a.post('/api/stream/validate', { url: MOCK_STREAM_URL });
      assertError(res, status, code);
      assert.ok(res.body.error.hint, `${code} has a hint`);
    }
    delete mock.streams[MOCK_VIDEO_ID];
  });
});

describe('stream: select / clear / lock while the scheduler is active', () => {
  const a = makeApp();
  const mock = a.chatProviders.test;

  before(async () => {
    await a.post('/api/messages/import', ['Stream message A', 'Stream message B']).expect(200);
    await withConnection(a);
  });

  it('requires a CSRF token and same origin', async () => {
    const res = await request(a.app).post('/api/stream/select').set('Host', HOST).set('Origin', ORIGIN).send({ url: MOCK_STREAM_URL });
    assertError(res, 403, 'BAD_CSRF');
    const del = await request(a.app).delete('/api/stream').set('Host', HOST).set('Origin', ORIGIN);
    assertError(del, 403, 'BAD_CSRF');
  });

  it('refuses offline and chat-less streams, then selects a live one', async () => {
    mock.streams.ended000001 = { status: 'ended' };
    mock.streams.nochat00001 = { chatAvailable: false };
    assertError(await a.post('/api/stream/select', { url: urlFor('ended000001') }), 409, 'STREAM_OFFLINE');
    assertError(await a.post('/api/stream/select', { url: urlFor('nochat00001') }), 409, 'CHAT_UNAVAILABLE');
    assert.equal((await a.get('/api/stream')).body.selection, null);

    const res = await a.post('/api/stream/select', { url: `https://youtu.be/${MOCK_VIDEO_ID}` }).expect(200);
    assert.equal(res.body.selection.videoId, MOCK_VIDEO_ID);
    assert.equal(res.body.selection.url, MOCK_STREAM_URL);
    assert.equal(res.body.validation.status, 'live');
    const got = await a.get('/api/stream').expect(200);
    assert.deepEqual(got.body.selection, res.body.selection);
    const status = await a.get('/api/scheduler/status').expect(200);
    assert.equal(status.body.stream.videoId, MOCK_VIDEO_ID);
    assert.doesNotMatch(got.text, /token/i);
  });

  it('409 SCHEDULER_ACTIVE when changing or clearing while running and while paused', async () => {
    await a.post('/api/scheduler/start', {}).expect(200);
    assert.equal((await a.get('/api/stream')).body.locked, true);
    assertError(await a.post('/api/stream/select', { url: urlFor('otherVideo1') }), 409, 'SCHEDULER_ACTIVE');
    assertError(await a.del('/api/stream', {}), 409, 'SCHEDULER_ACTIVE');
    await a.post('/api/scheduler/pause', {}).expect(200);
    assertError(await a.post('/api/stream/select', { url: urlFor('otherVideo1') }), 409, 'SCHEDULER_ACTIVE');
    assertError(await a.del('/api/stream', {}), 409, 'SCHEDULER_ACTIVE');
    assert.equal((await a.get('/api/stream')).body.selection.videoId, MOCK_VIDEO_ID, 'selection unchanged');
    assert.ok(mock.streamCalls.every((c) => c.videoId !== 'otherVideo1'), 'no provider lookup for the refused stream');
    await a.post('/api/scheduler/stop', {}).expect(200);
  });

  it('clears after stopping, logs stream events, and start then refuses', async () => {
    const res = await a.del('/api/stream', {}).expect(200);
    assert.deepEqual(res.body, { selection: null, locked: false });
    assertError(await a.post('/api/scheduler/start', {}), 400, 'NO_STREAM_SELECTED');
    const logs = await a.get('/api/logs?group=scheduler&limit=200').expect(200);
    const types = new Set(logs.body.items.map((e) => e.eventType));
    for (const t of ['stream.selected', 'stream.cleared']) assert.ok(types.has(t), t);
  });
});

describe('stream: selection persists across app restarts', () => {
  it('a new app instance on the same database sees the saved selection', async () => {
    const db = testDb();
    const first = makeApp({ db });
    await withConnection(first);
    await first.post('/api/stream/select', { url: MOCK_STREAM_URL }).expect(200);
    const second = makeApp({ db });
    const res = await second.get('/api/stream').expect(200);
    assert.equal(res.body.selection.videoId, MOCK_VIDEO_ID);
    assert.equal(res.body.selection.url, MOCK_STREAM_URL);
    assert.equal(res.body.locked, false);
  });
});

describe('stream: livestreams on another channel', () => {
  const a = makeApp();
  const mock = a.chatProviders.test;
  const EXT = 'extVideo001';
  const extUrl = urlFor(EXT);

  before(async () => {
    await a.post('/api/messages/import', ['External message A', 'External message B']).expect(200);
    await withConnection(a);
    mock.streams[EXT] = { videoId: EXT, liveChatId: 'ext-chat', title: 'Their stream', channelId: 'UCother', channelTitle: 'Other Channel', owned: false, chatReadable: true };
  });

  it('validates as live but posting permission stays unverified (never NOT_OWNER)', async () => {
    const res = await a.post('/api/stream/validate', { url: extUrl }).expect(200);
    assert.equal(res.body.status, 'live');
    assert.equal(res.body.owned, false);
    assert.equal(res.body.external, true);
    assert.equal(res.body.channelTitle, 'Other Channel');
    assert.equal(res.body.chatAvailable, true);
    assert.equal(res.body.chatReadable, true);
    assert.equal(res.body.postingPermission, 'unverified');
    assert.equal(res.body.requiresAcknowledgement, true);
    assert.equal(res.body.canConnect, true);
    assert.match(res.body.message, /cannot be verified in advance/);
    assert.deepEqual(mock.streamCalls.at(-1), { videoId: EXT, checkChat: true });
  });

  it('own stream: postingPermission owner, no acknowledgement needed', async () => {
    const res = await a.post('/api/stream/validate', { url: MOCK_STREAM_URL }).expect(200);
    assert.equal(res.body.owned, true);
    assert.equal(res.body.postingPermission, 'owner');
    assert.equal(res.body.requiresAcknowledgement, false);
  });

  it('chat that cannot be read is not connectable', async () => {
    mock.streams.extNoRead01 = { ...mock.streams[EXT], videoId: 'extNoRead01', chatReadable: false, chatAvailable: false, chatReason: 'This chat cannot be accessed by the connected account.' };
    const res = await a.post('/api/stream/validate', { url: urlFor('extNoRead01') }).expect(200);
    assert.equal(res.body.chatReadable, false);
    assert.equal(res.body.canConnect, false);
    assert.match(res.body.message, /cannot be accessed/);
  });

  it('select requires the acknowledgement, then stores external + acknowledgedAt', async () => {
    const refused = await a.post('/api/stream/select', { url: extUrl });
    assertError(refused, 400, 'ACKNOWLEDGEMENT_REQUIRED');
    assert.match(refused.body.error.message, /Other Channel/);
    assertError(await a.post('/api/stream/select', { url: extUrl, acknowledgeExternal: false }), 400, 'ACKNOWLEDGEMENT_REQUIRED');
    assertError(await a.post('/api/stream/select', { url: extUrl, acknowledgeExternal: 'yes' }), 400, 'VALIDATION_FAILED');
    assert.equal((await a.get('/api/stream')).body.selection, null);

    const res = await a.post('/api/stream/select', { url: extUrl, acknowledgeExternal: true }).expect(200);
    assert.equal(res.body.selection.videoId, EXT);
    assert.equal(res.body.selection.external, true);
    assert.ok(res.body.selection.acknowledgedAt);
  });

  it('cannot start without accepting the External Livestream Terms; a decline does not count', async () => {
    assertError(await a.post('/api/scheduler/start', {}), 409, 'TERMS_ACCEPTANCE_REQUIRED');
    const terms = (await a.get('/api/terms/external-stream').expect(200)).body;
    const connectionId = (await a.get('/api/scheduler/settings')).body.connectionId;
    await a.post('/api/terms/acknowledgements', { connectionId, videoId: EXT, accepted: false, termsVersion: terms.version, contentHash: terms.contentHash }).expect(201);
    assertError(await a.post('/api/scheduler/start', {}), 409, 'TERMS_ACCEPTANCE_REQUIRED');
    assert.equal(mock.sent.length, 0, 'nothing posted without acceptance');
  });

  it('after acceptance the scheduler posts to that exact chat id; withdrawing it blocks resume', async () => {
    const terms = (await a.get('/api/terms/external-stream').expect(200)).body;
    const connectionId = (await a.get('/api/scheduler/settings')).body.connectionId;
    const decide = (accepted) => a.post('/api/terms/acknowledgements', { connectionId, videoId: EXT, accepted, termsVersion: terms.version, contentHash: terms.contentHash }).expect(201);
    await decide(true);
    await a.post('/api/scheduler/start', {}).expect(200);
    await a.clock.advance(10_000);
    assert.deepEqual(mock.sent.map((m) => m.liveChatId), ['ext-chat']);
    await a.post('/api/scheduler/pause', {}).expect(200);
    await decide(false);
    assertError(await a.post('/api/scheduler/resume', {}), 409, 'TERMS_ACCEPTANCE_REQUIRED');
    await a.post('/api/scheduler/stop', {}).expect(200);
  });
});

describe('terms: External Livestream Terms routes', () => {
  const a = makeApp();
  let connectionId;
  let terms;
  const VID = 'extVideo001';

  before(async () => {
    connectionId = await withConnection(a);
    terms = (await a.get('/api/terms/external-stream').expect(200)).body;
  });

  it('serves the current versioned draft terms', () => {
    assert.equal(terms.draft, true);
    assert.match(terms.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(terms.sections.length >= 4);
    assert.match(terms.draftNotice, /legal review/i);
  });

  it('records decisions, lists history newest first, and stores no secrets', async () => {
    const body = { connectionId, videoId: VID, accepted: true, termsVersion: terms.version, contentHash: terms.contentHash };
    const rec = (await a.post('/api/terms/acknowledgements', body).expect(201)).body;
    assert.equal(rec.status, 'accepted');
    assert.equal(rec.termsVersion, terms.version);
    assert.match(rec.createdAt, /Z$/);
    await a.post('/api/terms/acknowledgements', { ...body, accepted: false }).expect(201);
    const hist = (await a.get(`/api/terms/acknowledgements?connectionId=${connectionId}`).expect(200)).body;
    assert.deepEqual(hist.items.map((r) => r.status), ['declined', 'accepted']);
    assert.equal(hist.current.version, terms.version);
    assert.doesNotMatch(JSON.stringify(hist), /token|password|secret/i);
  });

  it('rejects stale terms (409 TERMS_OUTDATED), bad input (400) and requests without CSRF (403)', async () => {
    const body = { connectionId, videoId: VID, accepted: true, termsVersion: 'old-version', contentHash: terms.contentHash };
    assertError(await a.post('/api/terms/acknowledgements', body), 409, 'TERMS_OUTDATED');
    assertError(await a.post('/api/terms/acknowledgements', { ...body, termsVersion: terms.version, accepted: 'yes' }), 400, 'VALIDATION_FAILED');
    assertError(await a.post('/api/terms/acknowledgements', { ...body, termsVersion: terms.version, extra: 1 }), 400, 'VALIDATION_FAILED');
    const res = await request(a.app).post('/api/terms/acknowledgements').set('Host', HOST).send({ ...body, termsVersion: terms.version });
    assert.equal(res.status, 403);
  });

  it('"Delete all local data" removes acknowledgements', async () => {
    const res = await a.post('/api/system/cleanup', { confirm: 'DELETE' }).expect(200);
    assert.ok(res.body.removed.termsAcknowledgements >= 1);
    assert.equal((await a.get('/api/terms/acknowledgements').expect(200)).body.items.length, 0);
  });
});

describe('terms: acceptance persists across an application restart', () => {
  it('a second app on the same database file can start without re-accepting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-terms-int-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'companion.db');
    const EXT = 'extVideo002';
    const setupStream = (app) => {
      app.chatProviders.test.streams[EXT] = { videoId: EXT, liveChatId: 'ext-chat-2', title: 'Their stream', channelId: 'UCother', channelTitle: 'Other', owned: false, chatReadable: true };
    };

    const db1 = openDatabase(file);
    const a1 = makeApp({ db: db1 });
    setupStream(a1);
    await a1.post('/api/messages/import', ['Restart message A', 'Restart message B']).expect(200);
    const connectionId = await withConnection(a1);
    await a1.post('/api/stream/select', { url: urlFor(EXT), acknowledgeExternal: true }).expect(200);
    const terms = (await a1.get('/api/terms/external-stream')).body;
    await a1.post('/api/terms/acknowledgements', { connectionId, videoId: EXT, accepted: true, termsVersion: terms.version, contentHash: terms.contentHash }).expect(201);
    db1.close();

    const db2 = openDatabase(file);
    const a2 = makeApp({ db: db2 });
    setupStream(a2);
    await a2.post('/api/scheduler/start', {}).expect(200);
    await a2.post('/api/scheduler/stop', {}).expect(200);
    db2.close();
  });
});

describe('scheduler: manual review routes', () => {
  const a = makeApp();
  const mock = a.chatProviders.test;

  before(async () => {
    await a.post('/api/messages/import', ['Review message A', 'Review message B', 'Review message C']).expect(200);
    await withConnection(a);
    await a.post('/api/stream/select', { url: MOCK_STREAM_URL }).expect(200);
    await a.put('/api/scheduler/settings', { reviewMode: true }).expect(200);
  });

  it('reviewMode is a persisted setting', async () => {
    assert.equal((await a.get('/api/scheduler/settings').expect(200)).body.reviewMode, true);
    assertError(await a.put('/api/scheduler/settings', { reviewMode: 'on' }), 400, 'VALIDATION_FAILED');
  });

  it('nothing to approve before a proposal; proposal shown in status; approve posts it once', async () => {
    assertError(await a.post('/api/scheduler/review/approve', {}), 409, 'NOT_RUNNING');
    await a.post('/api/scheduler/start', {}).expect(200);
    assertError(await a.post('/api/scheduler/review/approve', {}), 409, 'NO_PENDING_REVIEW');
    await a.clock.advance(10_000);
    const status = await a.get('/api/scheduler/status').expect(200);
    assert.ok(status.body.pendingReview?.text);
    assert.equal(mock.sent.length, 0);

    assertError(await a.post('/api/scheduler/review/approve', { extra: 1 }), 400, 'VALIDATION_FAILED');
    const res = await a.post('/api/scheduler/review/approve', {}).expect(200);
    assert.equal(res.body.result.sent, true);
    assert.equal(res.body.status.pendingReview, null);
    assert.deepEqual(mock.sent.map((m) => m.text), [status.body.pendingReview.text]);
  });

  it('reject discards the proposal without posting', async () => {
    await a.clock.advance(120_000);
    const before = (await a.get('/api/scheduler/status')).body.pendingReview;
    assert.ok(before);
    const res = await a.post('/api/scheduler/review/reject', {}).expect(200);
    assert.equal(res.body.pendingReview, null);
    assert.equal(mock.sent.length, 1);
    await a.post('/api/scheduler/stop', {}).expect(200);
    assertError(await a.post('/api/scheduler/review/reject', {}), 409, 'NOT_RUNNING');
  });
});
