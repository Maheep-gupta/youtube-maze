import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, createFakeClock, createMockChatProvider, MOCK_VIDEO_ID, MOCK_STREAM_URL } from '../helpers.js';
import { notFound } from '../../src/errors.js';
import { createActivityService } from '../../src/services/activity.js';
import { createMessagesService } from '../../src/services/messages.js';
import { createSchedulerService } from '../../src/services/scheduler.js';

function fakeConnections() {
  const conn = { id: 'c1', provider: 'test', label: 'Test channel', status: 'connected', isTestMode: true };
  return {
    conn,
    used: 0,
    errors: [],
    authError: null,
    get(id) { if (id !== conn.id) throw notFound('Connection'); return conn; },
    async getAuth(id) { this.get(id); if (this.authError) throw this.authError; return { test: true }; },
    markUsed() { this.used++; },
    markError(_id, err) { this.errors.push(err.code); },
  };
}

const SELECTED = { videoId: MOCK_VIDEO_ID, url: MOCK_STREAM_URL, title: 'Mock stream', channelTitle: 'Mock Channel', connectionId: 'c1' };

function setup({ texts = ['first message', 'second message', 'third message'], settings = {}, db = testDb(), clock = createFakeClock(), stream = SELECTED } = {}) {
  const activity = createActivityService({ db, clock });
  const messages = createMessagesService({ db, activity, clock });
  for (const text of texts) messages.create({ text, category: 'compliments' });
  const provider = createMockChatProvider('test');
  const connections = fakeConnections();
  const make = () => createSchedulerService({ db, activity, messages, connections, chatProviders: { test: provider }, clock, defaultProvider: 'test' });
  const scheduler = make();
  scheduler.updateSettings({ intervalSeconds: 30, minDelaySeconds: 10, connectionId: 'c1', ...settings });
  if (stream) scheduler.setSelection(stream);
  const sessionRow = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  const events = (type) => activity.list({ limit: 500 }).items.filter((e) => e.eventType === type);
  const totalTimesSent = () => messages.list({ limit: 500 }).items.reduce((n, m) => n + m.timesSent, 0);
  return { db, clock, activity, messages, provider, connections, scheduler, make, sessionRow, events, totalTimesSent };
}

const rejectsCode = (promise, code, status) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code);
  if (status) assert.equal(err.status, status);
  return true;
});

test('start schedules the first tick, sends via chained timers, and stop is idempotent', async () => {
  const t = setup();
  const status = await t.scheduler.start();
  assert.equal(status.state, 'running');
  assert.equal(status.session.status, 'running');
  assert.equal(status.session.liveChatId, 'chat1');
  assert.equal(status.msUntilNext, 10_000);
  assert.equal(status.isTestMode, true);
  assert.equal(t.clock.pending(), 1);

  await t.clock.advance(9_999);
  assert.equal(t.provider.sent.length, 0);
  await t.clock.advance(1);
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.provider.sent[0].liveChatId, 'chat1');
  assert.equal(t.clock.pending(), 1, 'exactly one timer chained after the tick');
  await t.clock.advance(30_000);
  assert.equal(t.provider.sent.length, 2);
  assert.equal(t.connections.used, 2);

  const sentEvents = t.events('message.sent');
  assert.equal(sentEvents.length, 2);
  assert.ok(sentEvents.every((e) => e.level === 'success' && e.details.providerMessageId));

  const stopped = t.scheduler.stop();
  assert.equal(stopped.state, 'idle');
  assert.equal(t.clock.pending(), 0);
  const row = t.sessionRow(status.session.id);
  assert.equal(row.status, 'stopped');
  assert.equal(row.messages_sent, 2);
  assert.equal(row.stop_reason, 'Stopped by user');
  assert.equal(t.scheduler.stop().state, 'idle', 'second stop is a no-op');
  await t.clock.advance(300_000);
  assert.equal(t.provider.sent.length, 2);
  assert.equal(t.events('scheduler.stop').length, 1);
});

test('start refusals: no connection, already running, not live, chat unavailable, no messages', async () => {
  const noConn = setup({ settings: { connectionId: null } });
  await rejectsCode(noConn.scheduler.start(), 'NO_CONNECTION', 400);

  const t = setup();
  await t.scheduler.start();
  await rejectsCode(t.scheduler.start(), 'ALREADY_RUNNING', 409);
  t.scheduler.stop();

  const notLive = setup();
  notLive.provider.live = false;
  await rejectsCode(notLive.scheduler.start(), 'NOT_LIVE', 409);
  assert.equal(notLive.scheduler.getStatus().state, 'idle');
  assert.equal(notLive.clock.pending(), 0);

  const noChat = setup();
  noChat.provider.chatAvailable = false;
  await rejectsCode(noChat.scheduler.start(), 'CHAT_UNAVAILABLE', 409);

  const empty = setup({ texts: [] });
  await rejectsCode(empty.scheduler.start(), 'NO_MESSAGES', 400);

  const badAuth = setup();
  const { ChatProviderError } = await import('../../src/errors.js');
  badAuth.connections.authError = new ChatProviderError('AUTH_FAILED', 'revoked');
  await rejectsCode(badAuth.scheduler.start(), 'AUTH_FAILED', 400);
  assert.deepEqual(badAuth.connections.errors, ['AUTH_FAILED']);
});

test('pause stops sending; resume reschedules honouring min delay', async () => {
  const t = setup({ settings: { minDelaySeconds: 20 } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 1);

  const paused = t.scheduler.pause();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.session.status, 'paused');
  assert.equal(t.clock.pending(), 0);
  assert.deepEqual(await t.scheduler.tick(), { skipped: 'not_running' });
  assert.equal(t.scheduler.pause().state, 'paused', 'pause is idempotent');

  await t.clock.advance(5_000);
  assert.equal(t.provider.sent.length, 1);
  const resumed = t.scheduler.resume();
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.session.status, 'running');
  assert.equal(resumed.msUntilNext, 15_000, 'lastSentAt + minDelay(20s) - 5s elapsed');
  await t.clock.advance(14_999);
  assert.equal(t.provider.sent.length, 1);
  await t.clock.advance(1);
  assert.equal(t.provider.sent.length, 2);

  t.scheduler.stop();
  assert.throws(() => t.scheduler.pause(), (err) => err.code === 'NOT_RUNNING');
  assert.throws(() => t.scheduler.resume(), (err) => err.code === 'NOT_RUNNING');
  assert.deepEqual(t.events('scheduler.pause').length, 1);
  assert.deepEqual(t.events('scheduler.resume').length, 1);
});

test('overlap guard: a second tick while a send is in flight is skipped', async () => {
  const t = setup();
  await t.scheduler.start();
  let release;
  t.provider.hold = new Promise((r) => { release = r; });

  const first = t.scheduler.tick();
  assert.equal(t.scheduler.getStatus().inFlight, true);
  const second = await t.scheduler.tick();
  assert.deepEqual(second, { skipped: 'overlap' });
  assert.equal(t.events('scheduler.tick_skipped').length, 1);

  // Let the first tick reach sendMessage, then release it.
  await new Promise((r) => setImmediate(r));
  release();
  const result = await first;
  assert.equal(result.sent, true);
  assert.equal(t.provider.calls.sendMessage, 1);
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.scheduler.getStatus().inFlight, false);
  t.scheduler.stop();
});

test('min delay: an immediate tick after a success is skipped', async () => {
  const t = setup();
  await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 1);
  const r = await t.scheduler.tick();
  assert.equal(r.skipped, 'min_delay');
  assert.equal(r.nextDelayMs, 10_000);
  assert.equal(t.provider.sent.length, 1);
  t.scheduler.stop();
});

test('fatal AUTH_FAILED stops the session with status error and records no send', async () => {
  const t = setup();
  const { session } = await t.scheduler.start();
  t.provider.failNext('AUTH_FAILED');
  await t.clock.advance(10_000);

  const status = t.scheduler.getStatus();
  assert.equal(status.state, 'idle');
  assert.equal(t.clock.pending(), 0);
  const row = t.sessionRow(session.id);
  assert.equal(row.status, 'error');
  assert.match(row.stop_reason, /AUTH_FAILED/);
  assert.equal(row.messages_sent, 0);
  assert.equal(row.messages_failed, 1);
  assert.deepEqual(t.connections.errors, ['AUTH_FAILED']);
  assert.equal(t.events('message.failed').length, 1);
  assert.equal(t.events('message.sent').length, 0);
  assert.equal(t.totalTimesSent(), 0);
  assert.equal(status.today.sent, 0);
});

test('stream ended (live=false) stops the session with NOT_LIVE', async () => {
  const t = setup();
  const { session } = await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 1);
  t.provider.live = false;
  await t.clock.advance(30_000);
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  assert.equal(t.clock.pending(), 0);
  const row = t.sessionRow(session.id);
  assert.equal(row.status, 'error');
  assert.match(row.stop_reason, /NOT_LIVE/);
});

test('stops after N consecutive non-fatal failures; failures never count as sent; success resets the streak', async () => {
  const t = setup({ settings: { maxConsecutiveFailures: 3 } });
  const { session } = await t.scheduler.start();

  t.provider.failNext('NETWORK');
  t.provider.failNext('NETWORK');
  await t.clock.advance(10_000);
  await t.clock.advance(30_000);
  assert.equal(t.scheduler.getStatus().state, 'running', 'two failures < max');
  await t.clock.advance(30_000); // success resets the streak
  assert.equal(t.provider.sent.length, 1);

  t.provider.failNext('NETWORK');
  t.provider.failNext('RATE_LIMITED');
  t.provider.failNext('UNKNOWN');
  await t.clock.advance(30_000);
  await t.clock.advance(30_000);
  assert.equal(t.scheduler.getStatus().state, 'running');
  await t.clock.advance(30_000);
  assert.equal(t.scheduler.getStatus().state, 'idle');

  const row = t.sessionRow(session.id);
  assert.equal(row.status, 'error');
  assert.match(row.stop_reason, /3 consecutive failures/);
  assert.equal(row.messages_sent, 1);
  assert.equal(row.messages_failed, 5);
  assert.equal(t.events('message.sent').length, 1);
  assert.equal(t.events('message.failed').length, 5);
  assert.equal(t.totalTimesSent(), 1);
  assert.equal(t.connections.used, 1);
  assert.deepEqual(t.connections.errors, [], 'non-auth failures do not mark the connection');
});

test('a send without providerMessageId is a failure, never a success', async () => {
  const t = setup({ settings: { maxConsecutiveFailures: 1 } });
  t.provider.sendMessage = async () => ({ publishedAt: new Date().toISOString() });
  const { session } = await t.scheduler.start();
  await t.clock.advance(10_000);
  const row = t.sessionRow(session.id);
  assert.equal(row.messages_sent, 0);
  assert.equal(row.messages_failed, 1);
  assert.equal(row.status, 'error');
  assert.equal(t.events('message.sent').length, 0);
  assert.equal(t.totalTimesSent(), 0);
  assert.equal(t.scheduler.getStatus().today.sent, 0);
});

test('session max completes the session', async () => {
  const t = setup({ settings: { maxMessagesPerSession: 2 } });
  const { session } = await t.scheduler.start();
  await t.clock.advance(10_000);
  await t.clock.advance(30_000);
  assert.equal(t.provider.sent.length, 2);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  assert.equal(t.clock.pending(), 0);
  await t.clock.advance(300_000);
  assert.equal(t.provider.sent.length, 2);
  const row = t.sessionRow(session.id);
  assert.equal(row.status, 'completed');
  assert.match(row.stop_reason, /Session limit/);
  assert.equal(t.events('scheduler.limit_reached')[0].details.limit, 'session');
});

test('daily limit applies across sessions and blocks a new start', async () => {
  const t = setup({ settings: { dailyLimit: 3 } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  await t.clock.advance(30_000);
  t.scheduler.stop();
  assert.equal(t.provider.sent.length, 2);

  const { session } = await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 3);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  const row = t.sessionRow(session.id);
  assert.equal(row.status, 'completed');
  assert.match(row.stop_reason, /Daily limit/);
  assert.deepEqual(t.scheduler.getStatus().today, { sent: 3, limit: 3 });
  assert.ok(t.events('scheduler.limit_reached').some((e) => e.details.limit === 'daily'));
  await rejectsCode(t.scheduler.start(), 'DAILY_LIMIT_REACHED', 409);
});

test('clearing activity logs does not reset the daily limit', async () => {
  const t = setup({ settings: { dailyLimit: 1 } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 1);
  t.activity.clear();
  assert.equal(t.scheduler.getStatus().today.sent, 1);
  await rejectsCode(t.scheduler.start(), 'DAILY_LIMIT_REACHED', 409);
});

test('scheduler never sends the same message twice in a row', async () => {
  const t = setup({ texts: ['message A', 'message B'], settings: { maxMessagesPerSession: 12 } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  for (let i = 0; i < 11; i++) await t.clock.advance(30_000);
  assert.equal(t.provider.sent.length, 12);
  for (let i = 1; i < t.provider.sent.length; i++) {
    assert.notEqual(t.provider.sent[i].text, t.provider.sent[i - 1].text);
  }
});

test('with a single eligible message the scheduler stops instead of repeating it', async () => {
  const t = setup({ texts: ['lonely message'] });
  const { session } = await t.scheduler.start();
  await t.clock.advance(10_000);
  await t.clock.advance(30_000);
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  assert.match(t.sessionRow(session.id).stop_reason, /No eligible messages/);
});

test('category filter is honoured by the scheduler', async () => {
  const t = setup({ settings: { categories: ['sarcasm'], maxMessagesPerSession: 2 } });
  t.messages.create({ text: 'sarcastic one', category: 'sarcasm' });
  t.messages.create({ text: 'sarcastic two', category: 'sarcasm' });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  await t.clock.advance(30_000);
  assert.deepEqual(t.provider.sent.map((s) => s.text).sort(), ['sarcastic one', 'sarcastic two']);
});

test('updateSettings validates and persists; visible through a fresh service on the same db', () => {
  const t = setup();
  assert.throws(() => t.scheduler.updateSettings({ intervalSeconds: 30, minDelaySeconds: 60 }), (err) => err.code === 'INVALID_SETTINGS');
  assert.throws(() => t.scheduler.updateSettings({ intervalSeconds: 5 }), (err) => err.code === 'INVALID_SETTINGS');
  assert.throws(() => t.scheduler.updateSettings({ bogus: 1 }), (err) => err.code === 'INVALID_SETTINGS');
  assert.throws(() => t.scheduler.updateSettings({ categories: ['nope'] }), (err) => err.code === 'INVALID_SETTINGS');
  assert.throws(() => t.scheduler.updateSettings({ connectionId: 'missing' }), (err) => err.status === 404);

  t.scheduler.updateSettings({ intervalSeconds: 90, dailyLimit: 50, categories: ['wholesome', 'wholesome', 'sarcasm'] });
  const fresh = t.make();
  assert.deepEqual(fresh.getSettings(), {
    intervalSeconds: 90, minDelaySeconds: 10, maxMessagesPerSession: 30, dailyLimit: 50,
    categories: ['wholesome', 'sarcasm'], maxConsecutiveFailures: 3, connectionId: 'c1', reviewMode: false,
  });
});

test('restart recovery marks running/paused sessions stopped and does not auto-resume', async () => {
  const db = testDb();
  const t = setup({ db });
  const { session } = await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 1);

  // Simulate a process restart: new clock, new scheduler on the same database.
  const clock2 = createFakeClock(t.clock.now() + 60_000);
  const activity2 = createActivityService({ db, clock: clock2 });
  const messages2 = createMessagesService({ db, activity: activity2, clock: clock2 });
  const provider2 = createMockChatProvider('test');
  const restarted = createSchedulerService({
    db, activity: activity2, messages: messages2, connections: fakeConnections(), chatProviders: { test: provider2 }, clock: clock2,
  });

  const row = t.sessionRow(session.id);
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'Application restarted');
  assert.ok(row.ended_at);
  assert.equal(row.messages_sent, 1, 'persisted counters survive the restart');

  const status = restarted.getStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.session.id, session.id);
  assert.equal(clock2.pending(), 0);
  await clock2.advance(600_000);
  assert.equal(provider2.sent.length, 0);
  assert.equal(status.today.sent, 1, 'daily count comes from persisted activity');
});

// ---- livestream selection binding ----------------------------------------------------------

test('start requires a selected livestream (NO_STREAM_SELECTED); a selection belongs to one account', async () => {
  const none = setup({ stream: null });
  await rejectsCode(none.scheduler.start(), 'NO_STREAM_SELECTED', 400);
  assert.equal(none.provider.calls.getStreamByVideoId, 0, 'no provider call without a selection');

  // A selection is stored on the account's own workflow, so an unknown account cannot hold one
  // and another account's selection can never be used by this one.
  const other = setup({ stream: null });
  assert.throws(() => other.scheduler.setSelection({ ...SELECTED, connectionId: 'someone-else' }), (err) => err.status === 404);
  await rejectsCode(other.scheduler.start(), 'NO_STREAM_SELECTED', 400);
});

test('start verifies the SELECTED video (with chat check) and records it on the session', async () => {
  const t = setup();
  const status = await t.scheduler.start();
  assert.deepEqual(t.provider.streamCalls[0], { videoId: MOCK_VIDEO_ID, checkChat: true });
  assert.equal(t.provider.calls.getActiveBroadcast, 0, 'never asks for "any active broadcast"');
  assert.equal(status.session.videoId, MOCK_VIDEO_ID);
  assert.equal(status.stream.videoId, MOCK_VIDEO_ID);
  assert.equal(status.locked, true);
  assert.equal(t.sessionRow(status.session.id).video_id, MOCK_VIDEO_ID);
  t.scheduler.stop();
  assert.equal(t.scheduler.getStatus().locked, false);
});

test('start refuses an offline (upcoming/ended) selected stream with NOT_LIVE naming the stream', async () => {
  for (const status of ['upcoming', 'ended', 'none']) {
    const t = setup();
    t.provider.streams[MOCK_VIDEO_ID] = { status, title: 'My Big Show' };
    await assert.rejects(t.scheduler.start(), (err) => {
      assert.equal(err.code, 'NOT_LIVE');
      assert.equal(err.status, 409);
      assert.match(err.message, /My Big Show/);
      return true;
    });
    assert.equal(t.scheduler.getStatus().state, 'idle');
  }
});

test('start refuses a live stream whose chat is unavailable (CHAT_UNAVAILABLE)', async () => {
  const t = setup();
  t.provider.streams[MOCK_VIDEO_ID] = { chatAvailable: false, chatReason: 'Live chat is disabled' };
  await rejectsCode(t.scheduler.start(), 'CHAT_UNAVAILABLE', 409);
});

test('start maps STREAM_NOT_FOUND / PERMISSION_DENIED / QUOTA_EXCEEDED from the provider', async () => {
  for (const [code, status] of [['STREAM_NOT_FOUND', 404], ['PERMISSION_DENIED', 403], ['QUOTA_EXCEEDED', 429]]) {
    const t = setup();
    t.provider.streams[MOCK_VIDEO_ID] = { error: code };
    await rejectsCode(t.scheduler.start(), code, status);
  }
});

test('ticks re-check the same video id only; another active broadcast never replaces it', async () => {
  const t = setup({ settings: { maxMessagesPerSession: 50 } });
  // A different broadcast on the same channel is live the whole time.
  t.provider.getActiveBroadcast = async () => ({ broadcastId: 'other', liveChatId: 'other-chat', title: 'Other live stream', channelId: 'UCmock' });
  t.provider.streams.otherVideo1 = { videoId: 'otherVideo1', liveChatId: 'other-chat', title: 'Other live stream' };
  await t.scheduler.start();
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 1);

  // The selected stream ends.
  t.provider.streams[MOCK_VIDEO_ID] = { status: 'ended' };
  await t.clock.advance(30_000);

  assert.ok(t.provider.streamCalls.every((c) => c.videoId === MOCK_VIDEO_ID), 'only the selected id is ever queried');
  assert.ok(t.provider.sent.every((m) => m.liveChatId === 'chat1'), 'only the selected chat is ever posted to');
  assert.equal(t.provider.sent.length, 1, 'nothing sent after the selected stream ended');
  const status = t.scheduler.getStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.session.status, 'error');
  assert.match(status.session.stopReason, /NOT_LIVE/);
  assert.equal(status.stream.videoId, MOCK_VIDEO_ID, 'selection is kept, not replaced');
  await t.clock.advance(300_000);
  assert.equal(t.provider.sent.length, 1);
});

test('a changed live chat id on the selected stream stops the session (no silent switch)', async () => {
  const t = setup();
  await t.scheduler.start();
  t.provider.streams[MOCK_VIDEO_ID] = { liveChatId: 'chat-NEW' };
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 0);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  assert.match(t.scheduler.getStatus().session.stopReason, /NOT_LIVE/);
});

test('chat becoming unavailable mid-session stops the session with CHAT_UNAVAILABLE', async () => {
  const t = setup();
  await t.scheduler.start();
  t.provider.streams[MOCK_VIDEO_ID] = { chatAvailable: false, chatReason: 'Chat was turned off' };
  await t.clock.advance(10_000);
  assert.equal(t.provider.sent.length, 0);
  const s = t.scheduler.getStatus();
  assert.equal(s.state, 'idle');
  assert.match(s.session.stopReason, /CHAT_UNAVAILABLE/);
});

test('authorization lost mid-session (stream check) stops the session and marks the connection', async () => {
  for (const code of ['AUTH_FAILED', 'PERMISSION_DENIED', 'STREAM_NOT_FOUND']) {
    const t = setup();
    await t.scheduler.start();
    t.provider.streamErrorNext(code);
    await t.clock.advance(10_000);
    assert.equal(t.provider.sent.length, 0, code);
    const s = t.scheduler.getStatus();
    assert.equal(s.state, 'idle', code);
    assert.equal(s.session.status, 'error', code);
    assert.match(s.session.stopReason, new RegExp(code));
  }
  const t = setup();
  await t.scheduler.start();
  t.connections.authError = Object.assign(new Error('token revoked'), { name: 'ChatProviderError', code: 'AUTH_FAILED', fatal: true });
  await t.clock.advance(10_000);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  assert.deepEqual(t.connections.errors, ['AUTH_FAILED']);
});

test('selection cannot be changed or cleared while running or paused', async () => {
  const t = setup();
  await t.scheduler.start();
  assert.throws(() => t.scheduler.setSelection({ ...SELECTED, videoId: 'otherVideo1' }), { code: 'SCHEDULER_ACTIVE' });
  assert.throws(() => t.scheduler.clearSelection(), { code: 'SCHEDULER_ACTIVE' });
  t.scheduler.pause();
  assert.throws(() => t.scheduler.setSelection({ ...SELECTED, videoId: 'otherVideo1' }), { code: 'SCHEDULER_ACTIVE' });
  assert.throws(() => t.scheduler.clearSelection(), { code: 'SCHEDULER_ACTIVE' });
  assert.equal(t.scheduler.getSelection().videoId, MOCK_VIDEO_ID);
  t.scheduler.stop();
  t.scheduler.setSelection({ ...SELECTED, videoId: 'otherVideo1' });
  assert.equal(t.scheduler.getSelection().videoId, 'otherVideo1');
  assert.equal(t.scheduler.clearSelection(), null);
  assert.equal(t.scheduler.getSelection(), null);
});

test('selection persists across a scheduler restart on the same database', async () => {
  const db = testDb();
  const t = setup({ db });
  const again = t.make();
  assert.deepEqual({ ...again.getSelection(), validatedAt: null }, { ...SELECTED, validatedAt: null, external: false, acknowledgedAt: null });
  assert.ok(again.getSelection().validatedAt);
});

// ---- streams on another channel ------------------------------------------------------------
const EXTERNAL = { ...SELECTED, videoId: 'extVideo001', url: 'https://www.youtube.com/watch?v=extVideo001', title: 'Their stream', channelTitle: 'Other Channel', external: true, acknowledgedAt: '2026-01-15T11:00:00.000Z' };
const externalStream = (o = {}) => ({ videoId: 'extVideo001', liveChatId: 'ext-chat', title: 'Their stream', channelId: 'UCother', channelTitle: 'Other Channel', owned: false, chatReadable: true, ...o });

test('external stream: posts only to that video chat id and stops when it ends', async () => {
  const t = setup({ stream: EXTERNAL, settings: { maxMessagesPerSession: 50 } });
  t.provider.streams.extVideo001 = externalStream();
  const status = await t.scheduler.start();
  assert.equal(status.session.videoId, 'extVideo001');
  assert.equal(status.session.liveChatId, 'ext-chat');
  assert.equal(status.stream.external, true);
  await t.clock.advance(10_000);
  assert.deepEqual(t.provider.sent.map((m) => m.liveChatId), ['ext-chat']);
  t.provider.streams.extVideo001 = externalStream({ status: 'ended', liveChatId: null, chatAvailable: false });
  await t.clock.advance(30_000);
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.scheduler.getStatus().state, 'idle');
  assert.match(t.scheduler.getStatus().session.stopReason, /NOT_LIVE/);
  assert.ok(t.provider.streamCalls.every((c) => c.videoId === 'extVideo001'));
});

test('posting refused by the chat (PERMISSION_DENIED) stops the session, is not counted, and does not flag the account', async () => {
  const t = setup({ stream: EXTERNAL });
  t.provider.streams.extVideo001 = externalStream();
  await t.scheduler.start();
  t.provider.failNext('PERMISSION_DENIED', 'YouTube API error (HTTP 403 forbidden)', { reason: 'forbidden' });
  await t.clock.advance(10_000);
  const s = t.scheduler.getStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.session.status, 'error');
  assert.equal(s.session.messagesSent, 0);
  assert.equal(s.session.messagesFailed, 1);
  assert.equal(t.totalTimesSent(), 0);
  assert.deepEqual(t.connections.errors, [], 'a chat refusal is not an account error');
  assert.equal(t.events('message.sent').length, 0);
});

test('missing OAuth scope (insufficientPermissions) does flag the account', async () => {
  const t = setup();
  await t.scheduler.start();
  t.provider.failNext('PERMISSION_DENIED', 'scope missing', { reason: 'insufficientPermissions' });
  await t.clock.advance(10_000);
  assert.deepEqual(t.connections.errors, ['PERMISSION_DENIED']);
});

test('rate limiting is not retried indefinitely: bounded by max consecutive failures', async () => {
  const t = setup({ settings: { maxConsecutiveFailures: 2 } });
  await t.scheduler.start();
  for (let i = 0; i < 3; i++) t.provider.failNext('RATE_LIMITED');
  await t.clock.advance(10_000);
  assert.equal(t.scheduler.getStatus().state, 'running');
  await t.clock.advance(30_000);
  const s = t.scheduler.getStatus();
  assert.equal(s.state, 'idle');
  assert.match(s.session.stopReason, /2 consecutive failures/);
  assert.equal(t.provider.calls.sendMessage, 2);
  await t.clock.advance(300_000);
  assert.equal(t.provider.calls.sendMessage, 2);
});

// ---- manual review mode ----------------------------------------------------------------------
test('review mode: a tick proposes a message without sending; later ticks keep the same proposal', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  const s = t.scheduler.getStatus();
  assert.equal(t.provider.calls.sendMessage, 0);
  assert.ok(s.pendingReview);
  assert.ok(['first message', 'second message', 'third message'].includes(s.pendingReview.text));
  assert.equal(t.events('scheduler.review_pending').length, 1);
  const first = s.pendingReview.messageId;
  const streamChecks = t.provider.calls.getStreamByVideoId;
  await t.clock.advance(60_000);
  assert.equal(t.provider.calls.sendMessage, 0);
  assert.equal(t.scheduler.getStatus().pendingReview.messageId, first);
  assert.equal(t.events('scheduler.review_pending').length, 1);
  assert.ok(t.provider.calls.getStreamByVideoId > streamChecks, 'liveness is still re-checked while waiting');
});

test('review mode: a waiting proposal is dropped when the stream ends', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  t.provider.streams[MOCK_VIDEO_ID] = { status: 'ended', chatAvailable: false };
  await t.clock.advance(30_000);
  const s = t.scheduler.getStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.pendingReview, null);
  assert.equal(t.provider.calls.sendMessage, 0);
});

test('review mode: approve sends exactly once, counts it, and clears the proposal', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  const { text } = t.scheduler.getStatus().pendingReview;
  const out = await t.scheduler.approveReview();
  assert.equal(out.result.sent, true);
  assert.ok(out.result.providerMessageId);
  assert.deepEqual(t.provider.sent, [{ liveChatId: 'chat1', text }]);
  assert.equal(out.status.pendingReview, null);
  assert.equal(out.status.session.messagesSent, 1);
  assert.equal(t.events('scheduler.review_approved').length, 1);
  await rejectsCode(t.scheduler.approveReview(), 'NO_PENDING_REVIEW', 409);
  assert.equal(t.provider.sent.length, 1);
});

test('review mode: a failed approved send is not counted as sent', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  t.provider.failNext('NETWORK');
  const out = await t.scheduler.approveReview();
  assert.equal(out.result.failed, 'NETWORK');
  assert.equal(out.status.session.messagesSent, 0);
  assert.equal(t.events('message.sent').length, 0);
});

test('review mode: no overlap while an approved send is in flight', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  let release;
  t.provider.hold = new Promise((r) => { release = r; });
  const approving = t.scheduler.approveReview();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await t.scheduler.tick(), { skipped: 'overlap' });
  await assert.rejects(t.scheduler.approveReview(), (err) => ['SEND_IN_PROGRESS', 'NO_PENDING_REVIEW'].includes(err.code) && err.status === 409);
  release();
  t.provider.hold = null;
  assert.equal((await approving).result.sent, true);
  assert.equal(t.provider.sent.length, 1);
});

test('review mode: approve inside the minimum delay is refused with TOO_SOON and keeps the proposal', async () => {
  const t = setup({ settings: { reviewMode: true, intervalSeconds: 30, minDelaySeconds: 10 } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  await t.scheduler.approveReview();
  await t.clock.advance(30_000);
  assert.ok(t.scheduler.getStatus().pendingReview);
  t.scheduler.updateSettings({ intervalSeconds: 3600, minDelaySeconds: 3600 });
  await assert.rejects(t.scheduler.approveReview(), (err) => {
    assert.equal(err.code, 'TOO_SOON');
    assert.equal(err.status, 409);
    assert.ok(err.details.waitMs > 0);
    return true;
  });
  assert.ok(t.scheduler.getStatus().pendingReview);
  assert.equal(t.provider.sent.length, 1);
});

test('review mode: reject proposes a different message next time and never posts', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  for (let i = 0; i < 6; i++) {
    const rejected = t.scheduler.getStatus().pendingReview.messageId;
    assert.equal(t.scheduler.rejectReview().pendingReview, null);
    await t.clock.advance(30_000);
    assert.notEqual(t.scheduler.getStatus().pendingReview.messageId, rejected);
  }
  assert.equal(t.events('scheduler.review_rejected').length, 6);
  assert.equal(t.provider.calls.sendMessage, 0);
});

test('review mode: approving after the stream ended stops the session and sends nothing', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  t.provider.streams[MOCK_VIDEO_ID] = { status: 'ended', chatAvailable: false };
  const out = await t.scheduler.approveReview();
  assert.equal(out.result.failed, 'NOT_LIVE');
  assert.equal(out.status.state, 'idle');
  assert.equal(out.status.pendingReview, null);
  assert.equal(t.provider.calls.sendMessage, 0);
});

test('review mode: approve while paused is refused; stop discards the proposal', async () => {
  const t = setup({ settings: { reviewMode: true } });
  await t.scheduler.start();
  await t.clock.advance(10_000);
  t.scheduler.pause();
  assert.ok(t.scheduler.getStatus().pendingReview, 'pause keeps the proposal');
  await rejectsCode(t.scheduler.approveReview(), 'PAUSED', 409);
  t.scheduler.stop();
  assert.equal(t.scheduler.getStatus().pendingReview, null);
  await rejectsCode(t.scheduler.approveReview(), 'NOT_RUNNING', 409);
  assert.throws(() => t.scheduler.rejectReview(), { code: 'NOT_RUNNING' });
  assert.equal(t.provider.calls.sendMessage, 0);
});
