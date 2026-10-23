import { CATEGORIES } from '../config.js';
import { plain, transaction } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import { normalizeForCompare, validateMessageText } from '../lib/text.js';

export const MAX_IMPORT_ITEMS = 5000;
const MESSAGE_SOURCES = new Set(['manual', 'import', 'ai', 'preset']);
const MAX_LIST_LIMIT = 500;

function toMessage(row) {
  if (!row) return null;
  const r = plain(row);
  return {
    id: r.id,
    text: r.text,
    category: r.category,
    enabled: r.enabled === 1,
    source: r.source,
    timesSent: r.times_sent,
    lastSentAt: r.last_sent_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const isUniqueViolation = (err) => /UNIQUE constraint failed/i.test(String(err?.message));

/**
 * Message library. Text is sanitized + validated with lib/text.js; duplicates are detected on
 * normalizeForCompare(text), which is also enforced by a UNIQUE index.
 */
export function createMessagesService({ db, activity, clock = { now: () => Date.now() } }) {
  const iso = () => new Date(clock.now()).toISOString();
  const byId = db.prepare('SELECT * FROM messages WHERE id = ?');
  const byNormalized = db.prepare('SELECT * FROM messages WHERE normalized = ?');

  function assertCategory(category) {
    if (!CATEGORIES.includes(category)) {
      throw new AppError('INVALID_MESSAGE', `Unknown category "${String(category).slice(0, 40)}". Use one of: ${CATEGORIES.join(', ')}.`, { status: 400 });
    }
  }

  function validateText(text) {
    if (typeof text !== 'string') throw new AppError('INVALID_MESSAGE', 'Message text must be a string.', { status: 400 });
    const result = validateMessageText(text);
    if (!result.ok) throw new AppError('INVALID_MESSAGE', result.reason, { status: 400 });
    return result.text;
  }

  function duplicateError(existing) {
    return new AppError('DUPLICATE_MESSAGE', 'An equivalent message already exists in the library.', {
      status: 409,
      details: { existingId: existing.id },
    });
  }

  function findDuplicate(text, { excludeId } = {}) {
    const normalized = normalizeForCompare(text);
    if (!normalized) return null;
    const row = toMessage(byNormalized.get(normalized));
    if (!row || (excludeId != null && row.id === Number(excludeId))) return null;
    return row;
  }

  function get(id) {
    const row = toMessage(byId.get(Number(id)));
    if (!row) throw notFound('Message');
    return row;
  }

  function list({ category, q, enabled, limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (typeof enabled === 'boolean') { clauses.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (q) { clauses.push('instr(lower(text), lower(?)) > 0'); params.push(String(q)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), MAX_LIST_LIMIT);
    const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM messages ${where}`).get(...params).n);
    const items = db.prepare(`SELECT * FROM messages ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, n, skip).map(toMessage);
    return { items, total };
  }

  /** Inserts without logging; throws AppError on invalid/duplicate. */
  function insertMessage({ text, category, enabled = true, source = 'manual' }) {
    const clean = validateText(text);
    assertCategory(category);
    const existing = findDuplicate(clean);
    if (existing) throw duplicateError(existing);
    const ts = iso();
    try {
      const { lastInsertRowid } = db.prepare(`INSERT INTO messages
        (text, normalized, category, enabled, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(clean, normalizeForCompare(clean), category, enabled === false ? 0 : 1,
          MESSAGE_SOURCES.has(source) ? source : 'manual', ts, ts);
      return get(Number(lastInsertRowid));
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dup = findDuplicate(clean);
        throw duplicateError(dup ?? { id: null });
      }
      throw err;
    }
  }

  function create(input = {}) {
    const msg = insertMessage(input);
    activity?.log({ eventType: 'message.created', level: 'info', category: msg.category, messageId: msg.id, details: { source: msg.source } });
    return msg;
  }

  function update(id, patch = {}) {
    const current = get(id);
    const next = { ...current };
    if (patch.text !== undefined) {
      next.text = validateText(patch.text);
      const dup = findDuplicate(next.text, { excludeId: current.id });
      if (dup) throw duplicateError(dup);
    }
    if (patch.category !== undefined) { assertCategory(patch.category); next.category = patch.category; }
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    try {
      db.prepare('UPDATE messages SET text = ?, normalized = ?, category = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(next.text, normalizeForCompare(next.text), next.category, next.enabled ? 1 : 0, iso(), current.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicateError(findDuplicate(next.text, { excludeId: current.id }) ?? { id: null });
      throw err;
    }
    const msg = get(current.id);
    activity?.log({
      eventType: 'message.updated', level: 'info', category: msg.category, messageId: msg.id,
      details: { fields: Object.keys(patch).filter((k) => ['text', 'category', 'enabled'].includes(k)) },
    });
    return msg;
  }

  function remove(id) {
    const msg = get(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    activity?.log({ eventType: 'message.deleted', level: 'info', category: msg.category, messageId: msg.id });
    return true;
  }

  /** Normalize every supported import format into [{ text, category, enabled }]. */
  function toImportItems(payload) {
    const invalid = () => new AppError('INVALID_IMPORT', 'Unsupported import format. Expected { version, messages: [...] }, an array, or { "<category>": ["text", ...] }.', { status: 400 });
    let raw;
    if (Array.isArray(payload)) {
      raw = payload;
    } else if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.messages)) {
        raw = payload.messages;
      } else {
        const entries = Object.entries(payload);
        if (!entries.length || !entries.every(([, v]) => Array.isArray(v))) throw invalid();
        raw = entries.flatMap(([category, texts]) => texts.map((text) => ({ text, category })));
      }
    } else {
      throw invalid();
    }
    if (raw.length > MAX_IMPORT_ITEMS) {
      throw new AppError('IMPORT_TOO_LARGE', `Imports are limited to ${MAX_IMPORT_ITEMS} messages per file.`, { status: 400 });
    }
    return raw.map((item) => {
      if (typeof item === 'string') return { text: item, category: 'compliments', enabled: true };
      if (item && typeof item === 'object') {
        return { text: item.text, category: item.category ?? 'compliments', enabled: item.enabled !== false };
      }
      return { text: item, category: 'compliments', enabled: true };
    });
  }

  function importMessages(payload, { source = 'import' } = {}) {
    const items = toImportItems(payload);
    const skipped = [];
    let imported = 0;
    transaction(db, () => {
      for (const item of items) {
        const shownText = typeof item.text === 'string' ? item.text.slice(0, 200) : String(item.text ?? '').slice(0, 200);
        try {
          insertMessage({ ...item, source });
          imported++;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          skipped.push({ text: shownText, reason: err.code === 'DUPLICATE_MESSAGE' ? 'Duplicate of an existing message.' : err.message });
        }
      }
    });
    activity?.log({ eventType: 'message.imported', level: 'info', details: { imported, skipped: skipped.length, source } });
    return { imported, skipped };
  }

  function exportMessages() {
    const rows = db.prepare('SELECT * FROM messages ORDER BY id ASC').all().map(toMessage);
    return {
      version: 1,
      exportedAt: iso(),
      messages: rows.map(({ text, category, enabled }) => ({ text, category, enabled })),
    };
  }

  function stats() {
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, { total: 0, enabled: 0 }]));
    let total = 0;
    let enabled = 0;
    for (const row of db.prepare('SELECT category, COUNT(*) AS total, SUM(enabled) AS enabled FROM messages GROUP BY category').all()) {
      const t = Number(row.total);
      const e = Number(row.enabled ?? 0);
      byCategory[row.category] = { total: t, enabled: e };
      total += t;
      enabled += e;
    }
    return { total, enabled, byCategory };
  }

  /**
   * Random enabled message, never `excludeId` (prevents consecutive repeats).
   * Returns null when the only candidate is `excludeId` or nothing is eligible.
   */
  function pickRandom({ categories, excludeId, excludeIds = [], random = Math.random } = {}) {
    const clauses = ['enabled = 1'];
    const params = [];
    if (Array.isArray(categories) && categories.length) {
      clauses.push(`category IN (${categories.map(() => '?').join(', ')})`);
      params.push(...categories);
    }
    for (const id of [excludeId, ...excludeIds]) {
      if (id != null) { clauses.push('id != ?'); params.push(Number(id)); }
    }
    const rows = db.prepare(`SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY id ASC`).all(...params);
    if (!rows.length) return null;
    const r = Number(random());
    const index = Math.min(rows.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * rows.length)));
    return toMessage(rows[index]);
  }

  /** Count enabled messages eligible for the given categories (empty = all). */
  function countEligible({ categories } = {}) {
    const params = [];
    let sql = 'SELECT COUNT(*) AS n FROM messages WHERE enabled = 1';
    if (Array.isArray(categories) && categories.length) {
      sql += ` AND category IN (${categories.map(() => '?').join(', ')})`;
      params.push(...categories);
    }
    return Number(db.prepare(sql).get(...params).n);
  }

  function markSent(id, isoTs = iso()) {
    db.prepare('UPDATE messages SET times_sent = times_sent + 1, last_sent_at = ? WHERE id = ?').run(isoTs, Number(id));
  }

  return { list, get, create, update, remove, findDuplicate, importMessages, exportMessages, stats, pickRandom, countEligible, markSent };
}
