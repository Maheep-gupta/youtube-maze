import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { testDb, testCipher } from '../helpers.js';
import { openDatabase, migrate } from '../../src/db/index.js';
import { redact, redactString, registerSecret } from '../../src/logger.js';
import { createCipher, loadEncryptionKey } from '../../src/security/crypto.js';
import { createRequestGuards } from '../../src/security/origin.js';
import { errorHandler } from '../../src/lib/errorHandler.js';
import { sanitizeText, normalizeForCompare, validateMessageText, visibleLength } from '../../src/lib/text.js';

describe('secret redaction', () => {
  test('redacts sensitive keys at any depth', () => {
    const out = redact({ access_token: 'ya29.x', nested: { refreshToken: '1//abc', apiKey: 'k', ok: 'fine' }, list: [{ password: 'p' }] });
    assert.equal(out.access_token, '[REDACTED]');
    assert.equal(out.nested.refreshToken, '[REDACTED]');
    assert.equal(out.nested.apiKey, '[REDACTED]');
    assert.equal(out.nested.ok, 'fine');
    assert.equal(out.list[0].password, '[REDACTED]');
  });

  test('redacts token patterns inside free text', () => {
    const s = redactString('Authorization: Bearer abc.def ya29.A0ARrdaM-token sk-proj-1234567890abcdefXYZ GOCSPX-secretvalue https://x?access_token=zzz&a=1');
    for (const leaked of ['abc.def', 'ya29.A0ARrdaM', 'sk-proj-1234567890', 'GOCSPX-secretvalue', 'zzz']) {
      assert.ok(!s.includes(leaked), `leaked ${leaked}: ${s}`);
    }
    assert.ok(s.includes('a=1'));
  });

  test('registered literal secrets are masked', () => {
    registerSecret('my-custom-secret-value');
    assert.equal(redactString('x my-custom-secret-value y'), 'x [REDACTED] y');
  });

  test('errors are reduced to name/code/message', () => {
    const err = Object.assign(new Error('failed with Bearer tok123'), { code: 'E', config: { headers: { Authorization: 'Bearer tok123' } } });
    const out = redact(err);
    assert.deepEqual(Object.keys(out).sort(), ['code', 'message', 'name']);
    assert.ok(!JSON.stringify(out).includes('tok123'));
  });
});

describe('token encryption', () => {
  test('round-trips and does not contain plaintext', () => {
    const c = testCipher();
    const enc = c.encryptJson({ refreshToken: '1//secret-refresh' });
    assert.ok(!enc.includes('secret-refresh'));
    assert.deepEqual(c.decryptJson(enc), { refreshToken: '1//secret-refresh' });
  });

  test('tampered ciphertext or wrong key fails', () => {
    const c = testCipher();
    const enc = c.encrypt('hello');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => c.decrypt(parts.join(':')));
    assert.throws(() => createCipher(crypto.randomBytes(32)).decrypt(enc));
  });

  test('key file is generated once and reused; bad env key rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-key-'));
    const keyPath = path.join(dir, 'secret.key');
    const k1 = loadEncryptionKey({ tokenEncryptionKey: '', keyPath });
    const k2 = loadEncryptionKey({ tokenEncryptionKey: '', keyPath });
    assert.ok(k1.equals(k2));
    assert.throws(() => loadEncryptionKey({ tokenEncryptionKey: 'short', keyPath }), /64 hex/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('request guards (CSRF / origin / host)', () => {
  const guards = createRequestGuards({ host: '127.0.0.1', port: 3000, csrfToken: 'tok' });
  const app = express();
  app.use(guards.hostGuard, express.json(), guards.csrfGuard);
  app.get('/x', (_req, res) => res.json({ ok: true }));
  app.post('/x', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  test('GET allowed from the loopback host', async () => {
    await request(app).get('/x').set('Host', '127.0.0.1:3000').expect(200);
  });

  test('foreign Host header rejected (DNS rebinding)', async () => {
    const res = await request(app).get('/x').set('Host', 'evil.example:3000').expect(403);
    assert.equal(res.body.error.code, 'BAD_HOST');
  });

  test('POST without Origin rejected', async () => {
    const res = await request(app).post('/x').set('Host', '127.0.0.1:3000').set('X-CSRF-Token', 'tok').expect(403);
    assert.equal(res.body.error.code, 'BAD_ORIGIN');
  });

  test('POST from another origin rejected', async () => {
    const res = await request(app).post('/x').set('Host', '127.0.0.1:3000').set('Origin', 'https://evil.example').set('X-CSRF-Token', 'tok').expect(403);
    assert.equal(res.body.error.code, 'BAD_ORIGIN');
  });

  test('POST with wrong CSRF token rejected', async () => {
    const res = await request(app).post('/x').set('Host', '127.0.0.1:3000').set('Origin', 'http://127.0.0.1:3000').set('X-CSRF-Token', 'nope').expect(403);
    assert.equal(res.body.error.code, 'BAD_CSRF');
  });

  test('POST same-origin with token accepted', async () => {
    await request(app).post('/x').set('Host', '127.0.0.1:3000').set('Origin', 'http://127.0.0.1:3000').set('X-CSRF-Token', 'tok').send({}).expect(200);
  });

  test('malformed JSON gives a clean 400', async () => {
    const res = await request(app).post('/x').set('Host', '127.0.0.1:3000').set('Origin', 'http://127.0.0.1:3000')
      .set('X-CSRF-Token', 'tok').set('Content-Type', 'application/json').send('{bad').expect(400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });
});

describe('message text rules', () => {
  test('sanitizes control chars, bullets, numbering and quotes', () => {
    assert.equal(sanitizeText('  1. "Great\u0007   stream!​"  '), 'Great stream!');
    assert.equal(sanitizeText('- nice'), 'nice');
  });

  test('normalization ignores case, punctuation and emoji', () => {
    assert.equal(normalizeForCompare('Great Stream!! 🔥'), normalizeForCompare('great stream'));
  });

  test('rejects empty, too long, links, and spam repetition', () => {
    assert.equal(validateMessageText('   ').ok, false);
    assert.equal(validateMessageText('a'.repeat(5) + ' ' + 'b'.repeat(200)).ok, false);
    assert.equal(validateMessageText('visit https://x.io').ok, false);
    assert.equal(validateMessageText('heyyyyyyyyyyyyy').ok, false);
    assert.equal(validateMessageText('🔥🔥').ok, false, 'emoji-only has no readable text');
    assert.equal(validateMessageText('Nice stream 🔥').ok, true);
  });

  test('length counts graphemes like YouTube', () => {
    assert.equal(visibleLength('👍🏽ok'), 3);
    assert.equal(validateMessageText('x'.repeat(10), { maxLength: 5 }).ok, false);
  });
});

describe('database', () => {
  test('migrations create all tables and are idempotent', () => {
    const db = testDb();
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['messages', 'account_connections', 'scheduler_settings', 'activity_logs', 'generated_drafts', 'sessions']) {
      assert.ok(tables.includes(t), `missing ${t}`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduler_settings').get().n, 1);
  });

  test('data persists across reopen of a file database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-db-'));
    const file = path.join(dir, 'x.db');
    let db = openDatabase(file);
    db.prepare("INSERT INTO messages (text, normalized, category, created_at, updated_at) VALUES ('Hi there', 'hi there', 'wholesome', 'now', 'now')").run();
    db.close();
    db = openDatabase(file);
    assert.equal(db.prepare('SELECT text FROM messages').get().text, 'Hi there');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
