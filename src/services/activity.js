import { plain } from '../db/index.js';
import { redact } from '../logger.js';

export const ACTIVITY_LEVELS = Object.freeze(['success', 'info', 'warning', 'error']);

/** UI filter groups -> event_type prefixes. */
export const ACTIVITY_GROUPS = Object.freeze({
  scheduler: ['scheduler.%', 'stream.%', 'terms.%'],
  messages: ['message.%'],
  drafts: ['draft.%'],
  connections: ['connection.%'],
  system: ['app.%', 'data.%'],
});

const MAX_DETAILS_BYTES = 4096;
const MAX_LIST_LIMIT = 500;
const MAX_EXPORT_ROWS = 50_000;

function serializeDetails(details) {
  if (details === undefined || details === null) return null;
  const json = JSON.stringify(redact(details));
  if (json === undefined) return null;
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAILS_BYTES) return json;
  // Keep the stored value valid JSON: wrap a truncated preview of the (already redacted) JSON.
  let preview = json.slice(0, MAX_DETAILS_BYTES - 64);
  while (Buffer.byteLength(JSON.stringify({ truncated: true, preview }), 'utf8') > MAX_DETAILS_BYTES) {
    preview = preview.slice(0, preview.length - 64);
  }
  return JSON.stringify({ truncated: true, preview });
}

function accountId(connectionId, details) {
  const id = connectionId ?? (typeof details?.connectionId === 'string' ? details.connectionId : null);
  return typeof id === 'string' && id ? id.slice(0, 100) : null;
}

function parseDetails(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function toEntry(row) {
  const r = plain(row);
  // Re-redact every field on read: stored rows are already redacted, this guards older or hand-edited rows.
  return redact({
    id: r.id,
    ts: r.ts,
    eventType: r.event_type,
    level: r.level,
    sessionId: r.session_id ?? null,
    connectionId: r.connection_id ?? null,
    provider: r.provider ?? null,
    category: r.category ?? null,
    outcome: r.outcome ?? null,
    messageId: r.message_id ?? null,
    details: parseDetails(r.details),
  });
}

function buildWhere({ level, group, sessionId, connectionId, beforeId } = {}) {
  const clauses = [];
  const params = [];
  if (level) { clauses.push('level = ?'); params.push(level); }
  if (group) {
    const patterns = ACTIVITY_GROUPS[group];
    if (patterns) {
      clauses.push(`(${patterns.map(() => 'event_type LIKE ?').join(' OR ')})`);
      params.push(...patterns);
    }
  }
  if (sessionId) { clauses.push('session_id = ?'); params.push(sessionId); }
  if (connectionId) { clauses.push('connection_id = ?'); params.push(connectionId); }
  if (beforeId) { clauses.push('id < ?'); params.push(beforeId); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Activity log. Every `details` payload is redacted before storage and again on export.
 * `clock` is optional (defaults to the system clock); pass the scheduler's clock in tests.
 */
export function createActivityService({ db, clock = { now: () => Date.now() } }) {
  const insert = db.prepare(`INSERT INTO activity_logs
    (ts, event_type, level, session_id, connection_id, provider, category, outcome, message_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare('SELECT * FROM activity_logs WHERE id = ?');

  /** `connectionId` ties the entry to one account's audit trail (falls back to details.connectionId). */
  function log({ eventType, level = 'info', sessionId, connectionId, provider, category, outcome, messageId, details } = {}) {
    if (typeof eventType !== 'string' || !eventType) throw new TypeError('activity.log requires eventType');
    const safeLevel = ACTIVITY_LEVELS.includes(level) ? level : 'info';
    const ts = new Date(clock.now()).toISOString();
    const { lastInsertRowid } = insert.run(
      ts,
      eventType,
      safeLevel,
      sessionId ?? null,
      accountId(connectionId, details),
      provider ?? null,
      category ?? null,
      outcome == null ? null : String(redact(String(outcome))),
      Number.isSafeInteger(messageId) ? messageId : null,
      serializeDetails(details),
    );
    return toEntry(byId.get(lastInsertRowid));
  }

  function list({ level, group, sessionId, connectionId, limit = 100, beforeId } = {}) {
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), MAX_LIST_LIMIT);
    const { where, params } = buildWhere({ level, group, sessionId, connectionId, beforeId });
    const rows = db.prepare(`SELECT * FROM activity_logs ${where} ORDER BY id DESC LIMIT ?`).all(...params, n);
    const items = rows.map(toEntry);
    return { items, nextBeforeId: items.length === n ? items[items.length - 1].id : null };
  }

  function recent(limit = 10) {
    return list({ limit }).items;
  }

  function exportAll(filters = {}) {
    const { where, params } = buildWhere({ level: filters.level, group: filters.group, sessionId: filters.sessionId, connectionId: filters.connectionId });
    const rows = db.prepare(`SELECT * FROM activity_logs ${where} ORDER BY id DESC LIMIT ?`).all(...params, MAX_EXPORT_ROWS);
    // Stored details are already redacted; redact again in case patterns were added since.
    return rows.map((row) => redact(toEntry(row)));
  }

  function clear() {
    return Number(db.prepare('DELETE FROM activity_logs').run().changes);
  }

  function countSentSince(isoTs) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event_type = 'message.sent' AND ts >= ?").get(isoTs);
    return Number(row.n);
  }

  return { log, list, recent, exportAll, clear, countSentSince };
}
