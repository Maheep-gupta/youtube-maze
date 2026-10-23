import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/index.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

/** A database as an older version left it: every migration before 005 applied. */
function legacyDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    if (file >= '005') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, '2026-10-01T00:00:00.000Z');
  }
  return db;
}

const ts = '2026-10-20T10:00:00.000Z';

test('005 copies the single-account settings and selection into that account\'s workflow and backfills account ids', () => {
  const db = legacyDb();
  db.prepare(`INSERT INTO account_connections (id, provider, label, external_id, scopes, status, created_at, updated_at)
    VALUES ('acc-1', 'youtube', 'My Channel', 'UCmine', '[]', 'connected', ?, ?)`).run(ts, ts);
  db.prepare(`UPDATE scheduler_settings SET interval_seconds = 90, min_delay_seconds = 45, max_messages_per_session = 12, daily_limit = 40,
    categories = '["sarcasm"]', max_consecutive_failures = 2, review_mode = 1, connection_id = 'acc-1',
    target_video_id = 'abcdefghijk', target_url = 'https://www.youtube.com/watch?v=abcdefghijk', target_title = 'Stream',
    target_channel_title = 'Other', target_connection_id = 'acc-1', target_validated_at = ?, target_external = 1, target_acknowledged_at = ?
    WHERE id = 1`).run(ts, ts);
  db.prepare(`INSERT INTO sessions (id, connection_id, provider, status, started_at) VALUES ('s1', 'acc-1', 'youtube', 'completed', ?)`).run(ts);
  db.prepare(`INSERT INTO send_ledger (ts, session_id, provider, provider_message_id, message_id) VALUES (?, 's1', 'youtube', 'yt-1', 1)`).run(ts);
  db.prepare(`INSERT INTO activity_logs (ts, event_type, level, session_id) VALUES (?, 'message.sent', 'success', 's1')`).run(ts);

  migrate(db);

  const w = { ...db.prepare("SELECT * FROM workflows WHERE connection_id = 'acc-1'").get() };
  assert.equal(w.interval_seconds, 90);
  assert.equal(w.min_delay_seconds, 45);
  assert.equal(w.max_messages_per_session, 12);
  assert.equal(w.daily_limit, 40);
  assert.equal(w.categories, '["sarcasm"]');
  assert.equal(w.max_consecutive_failures, 2);
  assert.equal(w.review_mode, 1);
  assert.equal(w.target_video_id, 'abcdefghijk');
  assert.equal(w.target_external, 1);
  assert.equal(w.target_acknowledged_at, ts);
  assert.equal(db.prepare("SELECT connection_id FROM send_ledger WHERE session_id = 's1'").get().connection_id, 'acc-1');
  assert.equal(db.prepare("SELECT connection_id FROM activity_logs WHERE session_id = 's1'").get().connection_id, 'acc-1');
  assert.equal(db.prepare('SELECT connection_id FROM scheduler_settings WHERE id = 1').get().connection_id, 'acc-1', 'legacy default kept');
  const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.ok(applied.includes('005_multi_account.sql'));
  assert.ok(applied.every((v, i, a) => i === 0 || a[i - 1] < v));
});

test('005 does not carry a selection validated with a different account, nor settings for a missing account', () => {
  const db = legacyDb();
  db.prepare(`INSERT INTO account_connections (id, provider, label, scopes, status, created_at, updated_at)
    VALUES ('acc-1', 'test', 'T', '[]', 'connected', ?, ?)`).run(ts, ts);
  db.prepare(`UPDATE scheduler_settings SET connection_id = 'acc-1', target_video_id = 'abcdefghijk', target_url = 'u',
    target_connection_id = 'acc-OTHER' WHERE id = 1`).run();
  migrate(db);
  const w = db.prepare("SELECT target_video_id FROM workflows WHERE connection_id = 'acc-1'").get();
  assert.equal(w.target_video_id, null);

  const orphan = legacyDb();
  orphan.prepare("UPDATE scheduler_settings SET connection_id = 'gone' WHERE id = 1").run();
  migrate(orphan);
  assert.equal(orphan.prepare('SELECT COUNT(*) AS n FROM workflows').get().n, 0);
});
