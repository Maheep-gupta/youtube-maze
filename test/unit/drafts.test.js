import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, createMockAiProvider } from '../helpers.js';
import { createDraftsService } from '../../src/services/drafts.js';
import { createPresetProvider } from '../../src/providers/ai/presetProvider.js';
import { PRESET_LIBRARY } from '../../src/providers/ai/presetLibrary.js';
import { AppError, AiProviderError } from '../../src/errors.js';
import { normalizeForCompare } from '../../src/lib/text.js';

/** Minimal in-memory stand-ins for the messages/activity services (contract only). */
function fakeMessages(initial = []) {
  let nextId = 100;
  const items = initial.map((m) => ({ id: nextId++, enabled: true, source: 'manual', ...m }));
  return {
    items,
    findDuplicate(text) {
      const n = normalizeForCompare(text);
      return items.find((m) => normalizeForCompare(m.text) === n) ?? null;
    },
    create({ text, category, enabled = true, source = 'manual' }) {
      const existing = this.findDuplicate(text);
      if (existing) throw new AppError('DUPLICATE_MESSAGE', 'A message with the same text already exists.', { status: 409, details: { existingId: existing.id } });
      const m = { id: nextId++, text, category, enabled, source };
      items.push(m);
      return m;
    },
  };
}
const fakeActivity = () => ({ entries: [], log(e) { this.entries.push(e); return e; } });

let db; let messages; let activity;
const build = ({ ai = createMockAiProvider({ configured: false }), preset = createPresetProvider() } = {}) =>
  createDraftsService({ db, activity, messages, aiProvider: ai, presetProvider: preset });

beforeEach(() => {
  db = testDb();
  messages = fakeMessages([{ text: 'Already in the library!', category: 'compliments' }]);
  activity = fakeActivity();
});

describe('drafts.generate', () => {
  test('sanitizes model output: numbering, bullets, quotes, control chars, fences', async () => {
    const ai = createMockAiProvider({
      output: ['1. "Great stream today!"', '- Love the energy 🎉', 'Hi\u0007 there​ friend', '```', '“Quoted nicely”'],
    });
    const out = await build({ ai }).generate({ category: 'compliments', count: 10 });
    assert.equal(out.provider, 'mock-ai');
    assert.deepEqual(out.drafts.map((d) => d.text), ['Great stream today!', 'Love the energy 🎉', 'Hi there friend', 'Quoted nicely']);
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].reason, /no readable text/i);
    for (const d of out.drafts) {
      assert.equal(d.status, 'pending');
      assert.equal(d.category, 'compliments');
      assert.equal(d.batchId, out.batchId);
      assert.equal(d.provider, 'mock-ai');
    }
  });

  test('rejects empty, over-length and link candidates', async () => {
    const ai = createMockAiProvider({
      output: ['', '   ', 'x y '.repeat(30), 'Watch at https://evil.example now', 'go to www.example.com', 'A fine message', 'heyyyyyyyyyyyy'],
    });
    const out = await build({ ai }).generate({ category: 'wholesome', maxLength: 50, count: 10 });
    assert.deepEqual(out.drafts.map((d) => d.text), ['A fine message']);
    const reasons = out.rejected.map((r) => r.reason);
    assert.equal(reasons.filter((r) => /empty/i.test(r)).length, 2);
    assert.ok(reasons.some((r) => /exceeds 50/.test(r)));
    assert.equal(reasons.filter((r) => /links/i.test(r)).length, 2);
    assert.ok(reasons.some((r) => /repeated/i.test(r)));
  });

  test('non-string candidates are rejected', async () => {
    const ai = createMockAiProvider({ output: [42, null, 'ok then'] });
    const out = await build({ ai }).generate({ category: 'wholesome' });
    assert.equal(out.drafts.length, 1);
    assert.equal(out.rejected.length, 2);
  });

  test('drops in-batch duplicates and duplicates of other pending drafts; flags library duplicates', async () => {
    const ai = createMockAiProvider({ output: ['Great STREAM!', 'great stream', 'already in the library', 'Fresh one'] });
    const svc = build({ ai });
    const first = await svc.generate({ category: 'compliments', count: 10 });
    assert.deepEqual(first.drafts.map((d) => d.text), ['Great STREAM!', 'already in the library', 'Fresh one']);
    assert.equal(first.rejected[0].reason, 'Duplicate within this batch.');
    const libDup = first.drafts.find((d) => d.text === 'already in the library');
    assert.equal(libDup.duplicateOf, messages.items[0].id);
    assert.equal(first.drafts.find((d) => d.text === 'Fresh one').duplicateOf, null);

    const second = await svc.generate({ category: 'compliments', count: 10 });
    assert.equal(second.drafts.length, 0);
    assert.ok(second.rejected.every((r) => /batch|review/.test(r.reason)));
    assert.equal(svc.list().length, 3);
  });

  test('stores at most `count` drafts', async () => {
    const ai = createMockAiProvider({ output: Array.from({ length: 10 }, (_, i) => `Distinct message ${'abcdefghij'[i]}`) });
    const out = await build({ ai }).generate({ category: 'motivation', count: 3 });
    assert.equal(out.drafts.length, 3);
  });

  test('passes options to the provider and logs draft.generated', async () => {
    const ai = createMockAiProvider({ output: ['Hello chat'] });
    await build({ ai }).generate({ category: 'sarcasm', tone: 'dry', count: 4, language: 'Hindi', maxLength: 80, emoji: 'none', length: 'medium' });
    assert.deepEqual(ai.calls[0], { category: 'sarcasm', tone: 'dry', count: 4, language: 'Hindi', maxLength: 80, emoji: 'none', length: 'medium' });
    const log = activity.entries.at(-1);
    assert.equal(log.eventType, 'draft.generated');
    assert.equal(log.category, 'sarcasm');
    assert.equal(log.details.generated, 1);
  });

  test('auto falls back to the preset provider when AI is not configured', async () => {
    const ai = createMockAiProvider({ configured: false, output: ['should not be used'] });
    const svc = build({ ai });
    const out = await svc.generate({ category: 'witty_jokes', count: 5 });
    assert.equal(out.provider, 'preset');
    assert.equal(ai.calls.length, 0);
    assert.equal(out.drafts.length, 5);
    for (const d of out.drafts) assert.ok(PRESET_LIBRARY.witty_jokes.includes(d.text));
    assert.deepEqual(svc.aiStatus(), { configured: false, provider: 'preset', model: null, baseUrlHost: null });
  });

  test('auto uses AI when configured; source=preset forces preset; source=ai without config is a 400', async () => {
    const ai = createMockAiProvider({ output: ['From the model'] });
    const svc = build({ ai });
    assert.equal((await svc.generate({ category: 'wholesome' })).provider, 'mock-ai');
    assert.equal((await svc.generate({ category: 'wholesome', source: 'preset' })).provider, 'preset');
    assert.equal(svc.aiStatus().configured, true);

    const unconfigured = build({ ai: createMockAiProvider({ configured: false }) });
    await assert.rejects(unconfigured.generate({ category: 'wholesome', source: 'ai' }), (e) => e instanceof AppError && e.code === 'NOT_CONFIGURED' && e.status === 400);
  });

  test('provider errors propagate and are logged; unknown category is rejected', async () => {
    const ai = createMockAiProvider({ error: new AiProviderError('RATE_LIMITED', 'slow down') });
    const svc = build({ ai });
    await assert.rejects(svc.generate({ category: 'wholesome' }), (e) => e.code === 'RATE_LIMITED');
    assert.equal(activity.entries.at(-1).level, 'error');
    assert.equal(svc.list().length, 0);
    await assert.rejects(svc.generate({ category: 'spam' }), (e) => e.code === 'INVALID_CATEGORY');
  });
});

describe('drafts review flow', () => {
  async function seed(texts = ['First draft', 'Second draft', 'Third draft']) {
    const svc = build({ ai: createMockAiProvider({ output: texts }) });
    const { drafts } = await svc.generate({ category: 'motivation', count: texts.length });
    return { svc, drafts };
  }

  test('drafts remain pending and create no messages until approved', async () => {
    const { svc, drafts } = await seed();
    assert.equal(messages.items.length, 1);
    assert.deepEqual(svc.list().map((d) => d.status), ['pending', 'pending', 'pending']);
    assert.equal(svc.list({ status: 'approved' }).length, 0);
    assert.equal(svc.list({ batchId: drafts[0].batchId }).length, 3);
  });

  test('approve creates messages and marks drafts approved', async () => {
    const { svc, drafts } = await seed();
    const res = await svc.approve([drafts[0].id, drafts[1].id, drafts[0].id]);
    assert.equal(res.approved.length, 2);
    assert.deepEqual(res.failed, []);
    const created = messages.items.slice(1);
    assert.deepEqual(created.map((m) => [m.text, m.category, m.source, m.enabled]), [
      ['First draft', 'motivation', 'ai', true], ['Second draft', 'motivation', 'ai', true],
    ]);
    assert.equal(res.approved[0].messageId, created[0].id);
    const approved = svc.list({ status: 'approved' });
    assert.equal(approved.length, 2);
    assert.ok(approved.every((d) => d.decidedAt));
    assert.equal(svc.list().length, 1);
    assert.equal(activity.entries.at(-1).eventType, 'draft.approved');

    const again = await svc.approve([drafts[0].id, 9999]);
    assert.deepEqual(again.approved, []);
    assert.deepEqual(again.failed.map((f) => f.draftId), [drafts[0].id, 9999]);
  });

  test('approving preset drafts uses source=preset', async () => {
    const svc = build();
    const { drafts } = await svc.generate({ category: 'wholesome', count: 1, source: 'preset' });
    await svc.approve([drafts[0].id]);
    assert.equal(messages.items.at(-1).source, 'preset');
  });

  test('library duplicate at approval time fails that draft only and stays pending', async () => {
    const { svc, drafts } = await seed(['Already in the library', 'Brand new']);
    assert.equal(drafts[0].duplicateOf, messages.items[0].id);
    const res = await svc.approve(drafts.map((d) => d.id));
    assert.deepEqual(res.approved.map((a) => a.draftId), [drafts[1].id]);
    assert.equal(res.failed[0].draftId, drafts[0].id);
    assert.match(res.failed[0].reason, /already exists/);
    assert.equal(svc.list()[0].id, drafts[0].id);
  });

  test('reject marks pending drafts rejected and never creates messages', async () => {
    const { svc, drafts } = await seed();
    assert.deepEqual(svc.reject([drafts[0].id, drafts[1].id, 12345]), { rejected: 2 });
    assert.deepEqual(svc.reject([drafts[0].id]), { rejected: 0 });
    assert.equal(svc.list({ status: 'rejected' }).length, 2);
    assert.equal(messages.items.length, 1);
    assert.equal(activity.entries.at(-1).eventType, 'draft.rejected');
    const res = await svc.approve([drafts[0].id]);
    assert.match(res.failed[0].reason, /already rejected/);
  });

  test('clearDecided removes approved/rejected drafts only', async () => {
    const { svc, drafts } = await seed();
    await svc.approve([drafts[0].id]);
    svc.reject([drafts[1].id]);
    assert.equal(svc.clearDecided(), 2);
    assert.deepEqual(svc.list({ status: 'all' }).map((d) => d.id), [drafts[2].id]);
  });

  test('editing a pending draft revalidates and recomputes duplicateOf', async () => {
    const { svc, drafts } = await seed();
    const edited = await svc.update(drafts[0].id, { text: '  2. "Already in the LIBRARY"  ' });
    assert.equal(edited.text, 'Already in the LIBRARY');
    assert.equal(edited.duplicateOf, messages.items[0].id);
    const fixed = await svc.update(drafts[0].id, { text: 'Totally unique now' });
    assert.equal(fixed.duplicateOf, null);

    await assert.rejects(svc.update(drafts[0].id, { text: '   ' }), (e) => e.code === 'INVALID_MESSAGE');
    await assert.rejects(svc.update(drafts[0].id, { text: 'a'.repeat(201) }), (e) => e.code === 'INVALID_MESSAGE');
    await assert.rejects(svc.update(drafts[0].id, { text: 'see https://x.example' }), (e) => e.code === 'INVALID_MESSAGE');
    await assert.rejects(svc.update(drafts[0].id, { text: 'second DRAFT' }), (e) => e.code === 'DUPLICATE_DRAFT' && e.status === 409);
    await assert.rejects(svc.update(424242, { text: 'x' }), (e) => e.status === 404);
    assert.equal(svc.list().find((d) => d.id === drafts[0].id).text, 'Totally unique now');

    await svc.approve([drafts[0].id]);
    await assert.rejects(svc.update(drafts[0].id, { text: 'changed' }), (e) => e.code === 'DRAFT_NOT_PENDING');
  });
});
