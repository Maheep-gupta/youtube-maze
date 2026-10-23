import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testDb } from '../helpers.js';
import { openDatabase } from '../../src/db/index.js';
import { notFound } from '../../src/errors.js';
import { createTermsService } from '../../src/services/terms.js';
import { EXTERNAL_STREAM_TERMS } from '../../src/legal/externalStreamTerms.js';

const VID = 'extVideo001';
const T = EXTERNAL_STREAM_TERMS;
const connections = {
  get(id) {
    if (id !== 'c1' && id !== 'c2') throw notFound('Connection');
    return { id, provider: 'youtube', externalId: `UC-${id}`, label: 'Someone', scopes: [] };
  },
};
const make = (db = testDb(), opts = {}) => createTermsService({ db, connections, activity: null, ...opts });
const accept = (svc, over = {}) => svc.record({ connectionId: 'c1', videoId: VID, accepted: true, termsVersion: T.version, contentHash: T.contentHash, ...over });

describe('External Livestream Terms', () => {
  test('terms are a versioned draft with a content hash, legal-review notice and no immunity claim', () => {
    assert.equal(T.draft, true);
    assert.match(T.draftNotice, /qualified legal review/i);
    assert.match(T.contentHash, /^[0-9a-f]{64}$/);
    const all = T.sections.flatMap((s) => s.paragraphs).join(' ');
    assert.match(all, /does not protect you from .*lawsuits, regulatory action/i);
    assert.match(all, /not permission from the stream owner, not authorization from YouTube/i);
    assert.doesNotMatch(all, /\b(you are|you will be) (fully )?(protected|immune)\b/i);
  });

  test('missing consent: nothing recorded -> requireAccepted throws 409 TERMS_ACCEPTANCE_REQUIRED', () => {
    const svc = make();
    assert.equal(svc.isAccepted({ connectionId: 'c1', videoId: VID }), false);
    assert.throws(() => svc.requireAccepted({ connectionId: 'c1', videoId: VID }), (e) => e.code === 'TERMS_ACCEPTANCE_REQUIRED' && e.status === 409);
  });

  test('declined consent is recorded and does not allow starting', () => {
    const svc = make();
    const rec = accept(svc, { accepted: false });
    assert.equal(rec.status, 'declined');
    assert.throws(() => svc.requireAccepted({ connectionId: 'c1', videoId: VID }), { code: 'TERMS_ACCEPTANCE_REQUIRED' });
  });

  test('acceptance is scoped to one account and one stream; a later decline withdraws it', () => {
    const svc = make();
    accept(svc);
    assert.doesNotThrow(() => svc.requireAccepted({ connectionId: 'c1', videoId: VID }));
    assert.equal(svc.isAccepted({ connectionId: 'c2', videoId: VID }), false, 'other account');
    assert.equal(svc.isAccepted({ connectionId: 'c1', videoId: 'otherVideo1' }), false, 'other stream');
    accept(svc, { accepted: false });
    assert.equal(svc.isAccepted({ connectionId: 'c1', videoId: VID }), false);
  });

  test('record stores version, UTC time, account + channel id, stream id and status, and nothing secret', () => {
    const db = testDb();
    const svc = make(db, { clock: { now: () => Date.parse('2026-10-21T10:00:00Z') } });
    const rec = accept(svc);
    assert.deepEqual({ ...rec, id: undefined }, {
      id: undefined, termsVersion: T.version, materialVersion: T.materialVersion, connectionId: 'c1', channelId: 'UC-c1',
      videoId: VID, status: 'accepted', createdAt: '2026-10-21T10:00:00.000Z', currentVersion: true,
    });
    const cols = db.prepare('PRAGMA table_info(terms_acknowledgements)').all().map((c) => c.name);
    for (const c of cols) assert.doesNotMatch(c, /token|password|secret|email|label/i);
  });

  test('stale version or hash (terms changed while shown) -> 409 TERMS_OUTDATED, nothing recorded', () => {
    const svc = make();
    assert.throws(() => accept(svc, { termsVersion: '0.9' }), (e) => e.code === 'TERMS_OUTDATED' && e.status === 409);
    assert.throws(() => accept(svc, { contentHash: 'f'.repeat(64) }), { code: 'TERMS_OUTDATED' });
    assert.equal(svc.history().length, 0);
  });

  test('validates input: accepted must be boolean, video id format, known account', () => {
    const svc = make();
    assert.throws(() => accept(svc, { accepted: 'yes' }), { code: 'VALIDATION_FAILED' });
    assert.throws(() => accept(svc, { videoId: 'bad id' }), { code: 'VALIDATION_FAILED' });
    assert.throws(() => accept(svc, { connectionId: 'nope' }), { code: 'NOT_FOUND' });
  });

  test('a material terms change requires renewed acknowledgement; old records stay in history', () => {
    const db = testDb();
    accept(make(db));
    const v2 = { ...T, version: '2.0-draft', materialVersion: 2, contentHash: 'a'.repeat(64) };
    const svc2 = make(db, { terms: v2 });
    assert.equal(svc2.isAccepted({ connectionId: 'c1', videoId: VID }), false);
    const hist = svc2.history({ connectionId: 'c1' });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].currentVersion, false);
    svc2.record({ connectionId: 'c1', videoId: VID, accepted: true, termsVersion: v2.version, contentHash: v2.contentHash });
    assert.equal(svc2.isAccepted({ connectionId: 'c1', videoId: VID }), true);
  });

  test('a non-material wording change keeps existing acknowledgements valid', () => {
    const db = testDb();
    accept(make(db));
    const v11 = { ...T, version: '1.1-draft', contentHash: 'b'.repeat(64) };
    assert.equal(make(db, { terms: v11 }).isAccepted({ connectionId: 'c1', videoId: VID }), true);
  });

  test('acknowledgements persist across restarts (file database reopened)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-terms-'));
    const file = path.join(dir, 'companion.db');
    try {
      const db1 = openDatabase(file);
      accept(make(db1));
      db1.close();
      const db2 = openDatabase(file);
      const svc = make(db2);
      assert.equal(svc.isAccepted({ connectionId: 'c1', videoId: VID }), true);
      assert.equal(svc.history().length, 1);
      db2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('history is newest first, filterable by account, and clearAll empties it', () => {
    const svc = make();
    accept(svc);
    accept(svc, { connectionId: 'c2', accepted: false });
    assert.deepEqual(svc.history().map((r) => r.connectionId), ['c2', 'c1']);
    assert.deepEqual(svc.history({ connectionId: 'c1' }).map((r) => r.status), ['accepted']);
    svc.clearAll();
    assert.equal(svc.history().length, 0);
  });
});
