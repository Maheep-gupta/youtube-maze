import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, createFakeClock } from '../helpers.js';
import { createActivityService } from '../../src/services/activity.js';

test('log stores entry with camelCase fields and redacts secrets in details', () => {
  const activity = createActivityService({ db: testDb() });
  const entry = activity.log({
    eventType: 'connection.error',
    level: 'error',
    provider: 'youtube',
    details: {
      accessToken: 'ya29.supersecretaccesstoken',
      nested: { refresh_token: '1//abcdefghijklmnopqrstuvwxyz' },
      note: 'header was Bearer abc.def.ghi and key sk-ABCDEFGHIJKLMNOPQRSTUV',
      url: 'https://x.test/cb?code=4/secretcode&state=ok',
    },
  });
  assert.equal(entry.eventType, 'connection.error');
  assert.equal(entry.level, 'error');
  assert.equal(entry.provider, 'youtube');
  const raw = JSON.stringify(entry.details);
  assert.ok(!raw.includes('supersecret'), raw);
  assert.ok(!raw.includes('abcdefghijklmnopqrstuvwxyz'), raw);
  assert.ok(!raw.includes('abc.def.ghi'), raw);
  assert.ok(!raw.includes('sk-ABCDEFGHIJKLMNOPQRSTUV'), raw);
  assert.ok(!raw.includes('4/secretcode'), raw);
  assert.equal(entry.details.accessToken, '[REDACTED]');

  const exported = JSON.stringify(activity.exportAll());
  assert.ok(!exported.includes('supersecret'));
});

test('details are truncated to 4 KB and remain valid JSON', () => {
  const db = testDb();
  const activity = createActivityService({ db });
  const entry = activity.log({ eventType: 'app.start', level: 'info', details: { blob: 'x'.repeat(10_000) } });
  assert.equal(entry.details.truncated, true);
  const stored = db.prepare('SELECT details FROM activity_logs WHERE id = ?').get(entry.id).details;
  assert.ok(Buffer.byteLength(stored) <= 4096);
  JSON.parse(stored);
});

test('invalid level falls back to info', () => {
  const activity = createActivityService({ db: testDb() });
  assert.equal(activity.log({ eventType: 'app.start', level: 'bogus' }).level, 'info');
});

test('list filters by level/group/session and paginates with beforeId', () => {
  const activity = createActivityService({ db: testDb() });
  for (let i = 0; i < 5; i++) activity.log({ eventType: 'scheduler.start', level: 'info', sessionId: 's1' });
  activity.log({ eventType: 'message.sent', level: 'success', sessionId: 's2' });
  activity.log({ eventType: 'message.failed', level: 'error', sessionId: 's2' });

  assert.equal(activity.list({ group: 'scheduler' }).items.length, 5);
  assert.equal(activity.list({ level: 'error' }).items.length, 1);
  assert.equal(activity.list({ sessionId: 's2' }).items.length, 2);

  const page1 = activity.list({ limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.ok(page1.nextBeforeId);
  assert.ok(page1.items[0].id > page1.items[2].id, 'newest first');
  const page2 = activity.list({ limit: 3, beforeId: page1.nextBeforeId });
  assert.ok(page2.items.every((e) => e.id < page1.nextBeforeId));
  const page3 = activity.list({ limit: 3, beforeId: page2.nextBeforeId });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.nextBeforeId, null);

  assert.equal(activity.recent(2).length, 2);
});

test('countSentSince counts only message.sent after the timestamp; clear removes all', async () => {
  const clock = createFakeClock(Date.parse('2026-01-15T10:00:00Z'));
  const activity = createActivityService({ db: testDb(), clock });
  activity.log({ eventType: 'message.sent', level: 'success' });
  await clock.advance(60_000);
  const since = new Date(clock.now()).toISOString();
  activity.log({ eventType: 'message.sent', level: 'success' });
  activity.log({ eventType: 'message.failed', level: 'error' });
  assert.equal(activity.countSentSince(since), 1);
  assert.equal(activity.countSentSince('2000-01-01T00:00:00.000Z'), 2);
  assert.equal(activity.clear(), 3);
  assert.equal(activity.list().items.length, 0);
});

test('entries persist and are visible through a fresh service on the same db', () => {
  const db = testDb();
  createActivityService({ db }).log({ eventType: 'app.start', level: 'info', details: { a: 1 } });
  const fresh = createActivityService({ db });
  const [entry] = fresh.list().items;
  assert.equal(entry.eventType, 'app.start');
  assert.deepEqual(entry.details, { a: 1 });
});
