import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, createFakeClock, createMockChatProvider } from '../helpers.js';
import { ChatProviderError, notFound } from '../../src/errors.js';
import { createActivityService } from '../../src/services/activity.js';
import { createMessagesService } from '../../src/services/messages.js';
import { createSchedulerManager } from '../../src/services/schedulerManager.js';

// Several independently authorized accounts, one workflow (engine) each. Mocked provider only.

const VID_A = 'videoAAAAA1';
const VID_B = 'videoBBBBB1';
const VID_X = 'videoXXXXX1'; // hosted by another channel (external for every account here)

/** Fake connections with two accounts, per-account auth, and account events. */
function fakeConnections(ids = ['a1', 'a2']) {
  const rows = new Map(ids.map((id) => [id, { id, provider: 'test', label: `Account ${id}`, status: 'connected', isTestMode: true }]));
  const listeners = new Set();
  return {
    rows,
    errors: [],
    authErrors: {},
    get(id) { const c = rows.get(id); if (!c) throw notFound('Connection'); return c; },
    list() { return [...rows.values()]; },
    async getAuth(id) {
      this.get(id);
      if (this.authErrors[id]) throw this.authErrors[id];
      return { test: true, account: id };
    },
    markUsed() {},
    markError(id, err) { this.errors.push({ id, code: err.code }); this.emit('auth_error', id, err); },
    onAccountEvent(fn) { listeners.add(fn); },
    emit(event, id, err) { for (const fn of listeners) fn(event, id, err); },
  };
}

function setup({ ids } = {}) {
  const db = testDb();
  const clock = createFakeClock();
  const activity = createActivityService({ db, clock });
  const messages = createMessagesService({ db, activity, clock });
  for (const text of ['one', 'two', 'three', 'four']) messages.create({ text, category: 'compliments' });
  const provider = createMockChatProvider('test');
  provider.streams[VID_A] = { liveChatId: 'chatA', title: 'Stream A' };
  provider.streams[VID_B] = { liveChatId: 'chatB', title: 'Stream B' };
  provider.streams[VID_X] = { liveChatId: 'chatX', title: 'Someone else', owned: false, chatReadable: true };
  const connections = fakeConnections(ids);
  const manager = createSchedulerManager({ db, activity, messages, connections, chatProviders: { test: provider }, clock });
  const select = (id, videoId, extra = {}) => {
    const e = manager.engine(id);
    e.updateSettings({ intervalSeconds: 30, minDelaySeconds: 10 });
    return e.setSelection({ videoId, url: `https://www.youtube.com/watch?v=${videoId}`, title: videoId, ...extra });
  };
  return { db, clock, activity, messages, provider, connections, manager, select };
}

const rejectsCode = (promise, code, status) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code);
  if (status) assert.equal(err.status, status);
  return true;
});

test('two owned accounts run concurrently; each sends only with its own auth to its own chat', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  await t.manager.engine('a1').start();
  await t.manager.engine('a2').start();
  await t.clock.advance(10_000);
  await t.clock.advance(30_000);

  const byAccount = (id) => t.provider.sendCalls.filter((c) => c.auth.account === id);
  assert.equal(byAccount('a1').length, 2);
  assert.equal(byAccount('a2').length, 2);
  assert.ok(byAccount('a1').every((c) => c.liveChatId === 'chatA'), 'a1 posts only to stream A');
  assert.ok(byAccount('a2').every((c) => c.liveChatId === 'chatB'), 'a2 posts only to stream B');
  assert.ok(t.provider.streamCalls.every((c) => c.videoId === VID_A || c.videoId === VID_B));

  // Per-account audit trail and per-account daily counts.
  const a1Logs = t.activity.list({ connectionId: 'a1', limit: 500 }).items;
  assert.ok(a1Logs.length > 0 && a1Logs.every((e) => e.connectionId === 'a1'));
  assert.equal(a1Logs.filter((e) => e.eventType === 'message.sent').length, 2);
  assert.equal(t.manager.engine('a1').getStatus().today.sent, 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM send_ledger WHERE connection_id = 'a2'").get().n, 2);

  // Stopping one leaves the other running.
  t.manager.engine('a1').stop();
  assert.equal(t.manager.engine('a1').getStatus().state, 'idle');
  assert.equal(t.manager.engine('a2').getStatus().state, 'running');
  await t.clock.advance(30_000);
  assert.equal(byAccount('a1').length, 2);
  assert.equal(byAccount('a2').length, 3);
  t.manager.stopAll('test end');
});

test('a fatal failure in one account stops only that account', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  const send = t.provider.sendMessage;
  t.provider.sendMessage = async (auth, args) => {
    if (auth.account === 'a1') throw new ChatProviderError('PERMISSION_DENIED', 'members-only chat');
    return send(auth, args);
  };
  await t.manager.engine('a1').start();
  await t.manager.engine('a2').start();
  await t.clock.advance(10_000);

  const a1 = t.manager.engine('a1').getStatus();
  assert.equal(a1.state, 'idle');
  assert.match(a1.session.stopReason, /PERMISSION_DENIED/);
  assert.equal(t.manager.engine('a2').getStatus().state, 'running');
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.provider.sent[0].liveChatId, 'chatB');
  assert.equal(t.connections.errors.length, 0, 'a chat refusing a post does not flag the account');
  t.manager.stopAll('test end');
});

test('auth lost for one account (account event) halts only that engine', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  await t.manager.engine('a1').start();
  await t.manager.engine('a2').start();
  t.connections.authErrors.a1 = new ChatProviderError('AUTH_FAILED', 'Token has been expired or revoked.');
  await t.clock.advance(10_000);
  assert.equal(t.manager.engine('a1').getStatus().state, 'idle');
  assert.match(t.manager.engine('a1').getStatus().session.stopReason, /AUTH_FAILED/);
  assert.deepEqual(t.connections.errors, [{ id: 'a1', code: 'AUTH_FAILED' }]);
  assert.equal(t.manager.engine('a2').getStatus().state, 'running');
  t.manager.stopAll('test end');
});

test('disconnect / remove stop that account only; remove deletes its workflow', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  await t.manager.engine('a1').start();
  await t.manager.engine('a2').start();

  t.connections.emit('disconnected', 'a1');
  assert.equal(t.manager.engine('a1').getStatus().state, 'idle');
  assert.equal(t.manager.engine('a1').getStatus().session.stopReason, 'Account disconnected');
  assert.equal(t.manager.engine('a2').getStatus().state, 'running');

  t.connections.emit('removed', 'a2');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE connection_id = 'a2'").get().n, 0);
  assert.equal(t.manager.peek('a2'), null);
  const session = t.db.prepare("SELECT status, stop_reason FROM sessions WHERE connection_id = 'a2'").get();
  assert.equal(session.status, 'stopped');
  assert.equal(session.stop_reason, 'Account removed');
  assert.equal(t.clock.pending(), 0, 'no timers left');
});

test('STREAM_IN_USE: two accounts can never run on the same stream', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_A);
  await t.manager.engine('a1').start();
  await rejectsCode(t.manager.engine('a2').start(), 'STREAM_IN_USE', 409);
  t.manager.engine('a1').stop();
  await t.manager.engine('a2').start();
  t.manager.stopAll('test end');
});

test('start race: two simultaneous starts on the same stream -> exactly one wins', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_A);
  const results = await Promise.allSettled([t.manager.engine('a1').start(), t.manager.engine('a2').start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.code, 'STREAM_IN_USE');
  t.manager.stopAll('test end');
});

test('CONCURRENT_EXTERNAL_BLOCKED: an external-stream workflow never runs alongside another (both directions)', async () => {
  // External start while another workflow runs.
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_X, { external: true, acknowledgedAt: new Date().toISOString() });
  await t.manager.engine('a1').start();
  await rejectsCode(t.manager.engine('a2').start(), 'CONCURRENT_EXTERNAL_BLOCKED', 409);

  // Any start while an external-stream workflow runs.
  t.manager.engine('a1').stop();
  await t.manager.engine('a2').start();
  await rejectsCode(t.manager.engine('a1').start(), 'CONCURRENT_EXTERNAL_BLOCKED', 409);
  t.manager.stopAll('test end');
  assert.equal(t.provider.sendCalls.length, 0);
});

test('external status is re-evaluated from the live lookup, not only the stored flag', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_X, { external: false }); // stored flag wrong/stale
  await t.manager.engine('a1').start();
  await rejectsCode(t.manager.engine('a2').start(), 'CONCURRENT_EXTERNAL_BLOCKED', 409);
  t.manager.stopAll('test end');
});

test('a single external workflow may run on its own (posting still unverified until YouTube confirms)', async () => {
  const t = setup();
  t.select('a2', VID_X, { external: true, acknowledgedAt: new Date().toISOString() });
  const status = await t.manager.engine('a2').start();
  assert.equal(status.state, 'running');
  await t.clock.advance(10_000);
  assert.deepEqual(t.provider.sendCalls.map((c) => [c.auth.account, c.liveChatId]), [['a2', 'chatX']]);
  t.manager.stopAll('test end');
});

test('no overlap per engine, but one account\'s in-flight send does not block another account', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  await t.manager.engine('a1').start();
  await t.manager.engine('a2').start();
  let release;
  t.provider.hold = new Promise((r) => { release = r; });
  const first = t.manager.engine('a1').tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await t.manager.engine('a1').tick(), { skipped: 'overlap' });
  const other = t.manager.engine('a2').tick();
  await new Promise((r) => setImmediate(r));
  release();
  t.provider.hold = null;
  const [r1, r2] = await Promise.all([first, other]);
  assert.equal(r1.sent, true);
  assert.equal(r2.sent, true);
  t.manager.stopAll('test end');
});

test('a stream selection can not change while that account runs; other accounts are unaffected', async () => {
  const t = setup();
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  await t.manager.engine('a1').start();
  assert.throws(() => t.manager.engine('a1').setSelection({ videoId: VID_B, url: 'u' }), { code: 'SCHEDULER_ACTIVE' });
  t.manager.engine('a2').clearSelection();
  assert.equal(t.manager.engine('a2').getSelection(), null);
  assert.equal(t.manager.engine('a1').getSelection().videoId, VID_A);
  t.manager.stopAll('test end');
});

test('unknown account -> 404; daily limit is counted per account', async () => {
  const t = setup();
  assert.throws(() => t.manager.engine('nope'), (err) => err.status === 404);
  t.select('a1', VID_A);
  t.select('a2', VID_B);
  t.manager.engine('a1').updateSettings({ dailyLimit: 1 });
  await t.manager.engine('a1').start();
  await t.clock.advance(10_000);
  assert.equal(t.manager.engine('a1').getStatus().state, 'idle', 'a1 hit its own daily limit');
  await t.manager.engine('a2').start();
  assert.equal(t.manager.engine('a2').getStatus().today.sent, 0, 'a1 sends do not count against a2');
  t.manager.stopAll('test end');
});
