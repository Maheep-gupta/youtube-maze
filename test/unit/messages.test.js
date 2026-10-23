import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers.js';
import { createActivityService } from '../../src/services/activity.js';
import { createMessagesService } from '../../src/services/messages.js';

function setup(db = testDb()) {
  const activity = createActivityService({ db });
  return { db, activity, messages: createMessagesService({ db, activity }) };
}

const rejects = (fn, code) => assert.throws(fn, (err) => { assert.equal(err.code, code); return true; });

test('create returns camelCase message, sanitized, and logs message.created', () => {
  const { messages, activity } = setup();
  const msg = messages.create({ text: '  "Great   stream!"  ', category: 'compliments' });
  assert.equal(msg.text, 'Great stream!');
  assert.equal(msg.category, 'compliments');
  assert.equal(msg.enabled, true);
  assert.equal(msg.source, 'manual');
  assert.equal(msg.timesSent, 0);
  assert.equal(msg.lastSentAt, null);
  assert.ok(msg.createdAt && msg.updatedAt);
  assert.equal(activity.list({ group: 'messages' }).items[0].eventType, 'message.created');
});

test('invalid messages are rejected: empty, >200 chars, links, unknown category', () => {
  const { messages } = setup();
  rejects(() => messages.create({ text: '   ', category: 'compliments' }), 'INVALID_MESSAGE');
  rejects(() => messages.create({ text: 'ab '.repeat(67) + 'ab', category: 'compliments' }), 'INVALID_MESSAGE');
  rejects(() => messages.create({ text: 'see https://example.com now', category: 'compliments' }), 'INVALID_MESSAGE');
  rejects(() => messages.create({ text: 'visit www.example.com', category: 'compliments' }), 'INVALID_MESSAGE');
  rejects(() => messages.create({ text: 'fine text', category: 'nope' }), 'INVALID_MESSAGE');
  // Exactly 200 chars is allowed.
  assert.equal(messages.create({ text: 'ab '.repeat(66) + 'ab', category: 'sarcasm' }).text.length, 200);
  assert.equal(messages.stats().total, 1);
});

test('duplicate prevention on create, update and import (case/punctuation insensitive)', () => {
  const { messages } = setup();
  const a = messages.create({ text: 'You are awesome!', category: 'compliments' });
  const b = messages.create({ text: 'Keep going', category: 'motivation' });

  assert.throws(() => messages.create({ text: 'you are AWESOME', category: 'wholesome' }), (err) => {
    assert.equal(err.code, 'DUPLICATE_MESSAGE');
    assert.equal(err.status, 409);
    assert.equal(err.details.existingId, a.id);
    return true;
  });
  rejects(() => messages.update(b.id, { text: 'You are awesome.' }), 'DUPLICATE_MESSAGE');
  // Updating a message to its own text (different casing) is fine.
  assert.equal(messages.update(a.id, { text: 'YOU are awesome!' }).text, 'YOU are awesome!');

  const result = messages.importMessages({
    version: 1,
    messages: [
      { text: 'you are awesome', category: 'compliments' },
      { text: 'Brand new one', category: 'wholesome' },
      { text: 'brand NEW one!', category: 'wholesome' },
    ],
  });
  assert.equal(result.imported, 1);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((s) => /duplicate/i.test(s.reason)));

  assert.equal(messages.findDuplicate('KEEP going!!').id, b.id);
  assert.equal(messages.findDuplicate('KEEP going!!', { excludeId: b.id }), null);
});

test('import accepts all supported formats and skips invalid items', () => {
  const { messages } = setup();
  assert.equal(messages.importMessages(['plain string one', 'plain string two']).imported, 2);
  assert.equal(messages.list({ category: 'compliments' }).total, 2);
  assert.equal(messages.importMessages([{ text: 'array object', category: 'sarcasm', enabled: false }]).imported, 1);
  assert.equal(messages.list({ category: 'sarcasm' }).items[0].enabled, false);
  const legacy = messages.importMessages({ witty_jokes: ['joke one', 'joke two'], made_up: ['nope'] });
  assert.equal(legacy.imported, 2);
  assert.equal(legacy.skipped.length, 1);
  assert.match(legacy.skipped[0].reason, /Unknown category/);
  const bad = messages.importMessages([{ text: '', category: 'motivation' }, { text: 'http://spam.example', category: 'motivation' }]);
  assert.equal(bad.imported, 0);
  assert.equal(bad.skipped.length, 2);
  rejects(() => messages.importMessages('nope'), 'INVALID_IMPORT');
  rejects(() => messages.importMessages(Array.from({ length: 5001 }, (_, i) => `m${i}`)), 'IMPORT_TOO_LARGE');
  assert.ok(messages.list({ limit: 500 }).items.every((m) => m.source === 'import'));
});

test('list filters by category, q and enabled; supports paging', () => {
  const { messages } = setup();
  messages.create({ text: 'Hello Friends', category: 'wholesome' });
  messages.create({ text: 'Bye friends', category: 'wholesome', enabled: false });
  messages.create({ text: 'Sarcastic remark', category: 'sarcasm' });
  assert.equal(messages.list({ category: 'wholesome' }).total, 2);
  assert.equal(messages.list({ q: 'FRIENDS' }).total, 2);
  assert.equal(messages.list({ enabled: false }).total, 1);
  const page = messages.list({ limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
});

test('get/remove 404, export has no ids, stats per category', () => {
  const { messages } = setup();
  const m = messages.create({ text: 'one', category: 'motivation' });
  messages.create({ text: 'two', category: 'motivation', enabled: false });
  const exp = messages.exportMessages();
  assert.equal(exp.version, 1);
  assert.deepEqual(exp.messages[0], { text: 'one', category: 'motivation', enabled: true });
  assert.ok(!('id' in exp.messages[0]));
  const stats = messages.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.enabled, 1);
  assert.deepEqual(stats.byCategory.motivation, { total: 2, enabled: 1 });
  assert.deepEqual(stats.byCategory.sarcasm, { total: 0, enabled: 0 });
  messages.remove(m.id);
  assert.throws(() => messages.get(m.id), (err) => err.status === 404);
  assert.throws(() => messages.remove(m.id), (err) => err.status === 404);
});

test('pickRandom is deterministic with injected random and filters categories', () => {
  const { messages } = setup();
  const a = messages.create({ text: 'alpha', category: 'compliments' });
  const b = messages.create({ text: 'bravo', category: 'compliments' });
  const c = messages.create({ text: 'charlie', category: 'sarcasm' });
  messages.create({ text: 'delta disabled', category: 'compliments', enabled: false });

  assert.equal(messages.pickRandom({ random: () => 0 }).id, a.id);
  assert.equal(messages.pickRandom({ random: () => 0.5 }).id, b.id);
  assert.equal(messages.pickRandom({ random: () => 0.9999 }).id, c.id);
  assert.equal(messages.pickRandom({ categories: ['sarcasm'], random: () => 0 }).id, c.id);
  for (let i = 0; i < 20; i++) {
    const picked = messages.pickRandom({ categories: ['compliments'], random: () => i / 20 });
    assert.equal(picked.category, 'compliments');
    assert.equal(picked.enabled, true);
  }
  assert.equal(messages.pickRandom({ categories: ['motivation'] }), null);
});

test('pickRandom never returns excludeId (no consecutive repeat)', () => {
  const { messages } = setup();
  const a = messages.create({ text: 'only one', category: 'wholesome' });
  assert.equal(messages.pickRandom({ excludeId: a.id }), null, 'single candidate equal to excludeId -> null');
  const b = messages.create({ text: 'second', category: 'wholesome' });
  for (const r of [0, 0.3, 0.6, 0.99]) {
    assert.equal(messages.pickRandom({ excludeId: a.id, random: () => r }).id, b.id);
  }
});

test('markSent increments counters; data persists via a fresh service on the same db', () => {
  const db = testDb();
  const { messages } = setup(db);
  const m = messages.create({ text: 'persist me', category: 'witty_jokes' });
  messages.markSent(m.id, '2026-01-15T12:00:00.000Z');
  messages.markSent(m.id, '2026-01-15T12:05:00.000Z');

  const fresh = createMessagesService({ db, activity: createActivityService({ db }) });
  const loaded = fresh.get(m.id);
  assert.equal(loaded.text, 'persist me');
  assert.equal(loaded.timesSent, 2);
  assert.equal(loaded.lastSentAt, '2026-01-15T12:05:00.000Z');
});
