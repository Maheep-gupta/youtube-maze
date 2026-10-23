import { plain } from '../db/index.js';
import { AppError } from '../errors.js';
import { EXTERNAL_STREAM_TERMS } from '../legal/externalStreamTerms.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function toRecord(row, terms) {
  const r = plain(row);
  return {
    id: r.id,
    termsVersion: r.terms_version,
    materialVersion: r.material_version,
    connectionId: r.connection_id,
    channelId: r.channel_id ?? null,
    videoId: r.video_id,
    status: r.status,
    createdAt: r.created_at,
    currentVersion: r.material_version === terms.materialVersion,
  };
}

/**
 * External Livestream Terms acknowledgements. An acknowledgement is a local record of the user's
 * decision; it is NOT authorization: callers still run every connection, ownership and chat check.
 * The latest decision for (account, video, current material version) wins, so a decline after an
 * acceptance withdraws it.
 */
export function createTermsService({ db, connections, activity, clock = { now: () => Date.now() }, terms = EXTERNAL_STREAM_TERMS }) {
  const insert = db.prepare(`INSERT INTO terms_acknowledgements
    (terms_id, terms_version, material_version, content_hash, connection_id, channel_id, video_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const latestFor = db.prepare(`SELECT * FROM terms_acknowledgements
    WHERE terms_id = ? AND connection_id = ? AND video_id = ? AND material_version = ? ORDER BY id DESC LIMIT 1`);

  const current = () => terms;

  /** Record an accept/decline of the terms text the user was shown (version + hash must be current). */
  function record({ connectionId, videoId, accepted, termsVersion, contentHash } = {}) {
    if (typeof accepted !== 'boolean') throw new AppError('VALIDATION_FAILED', '"accepted" must be true or false.', { status: 400 });
    if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) throw new AppError('VALIDATION_FAILED', 'Invalid video id.', { status: 400 });
    if (termsVersion !== terms.version || contentHash !== terms.contentHash) {
      throw new AppError('TERMS_OUTDATED', 'The terms changed since they were shown. Read the current version and decide again.', { status: 409, details: { termsVersion: terms.version } });
    }
    const connection = connections.get(connectionId); // 404 if unknown
    const status = accepted ? 'accepted' : 'declined';
    const { lastInsertRowid } = insert.run(terms.id, terms.version, terms.materialVersion, terms.contentHash,
      connection.id, connection.externalId ?? null, videoId, status, new Date(clock.now()).toISOString());
    activity?.log({
      eventType: accepted ? 'terms.accepted' : 'terms.declined', level: accepted ? 'info' : 'warning',
      provider: connection.provider, connectionId: connection.id, outcome: status,
      details: { termsVersion: terms.version, videoId },
    });
    return toRecord(db.prepare('SELECT * FROM terms_acknowledgements WHERE id = ?').get(lastInsertRowid), terms);
  }

  function isAccepted({ connectionId, videoId }) {
    const row = latestFor.get(terms.id, String(connectionId), String(videoId), terms.materialVersion);
    return plain(row)?.status === 'accepted';
  }

  /** Throws 409 TERMS_ACCEPTANCE_REQUIRED unless the current terms are accepted for this account + stream. */
  function requireAccepted({ connectionId, videoId }) {
    if (isAccepted({ connectionId, videoId })) return;
    throw new AppError('TERMS_ACCEPTANCE_REQUIRED',
      'Read and accept the External Livestream Terms for this account and livestream before starting.',
      { status: 409, details: { termsVersion: terms.version, videoId } });
  }

  function history({ connectionId, limit = 100 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = connectionId
      ? db.prepare('SELECT * FROM terms_acknowledgements WHERE terms_id = ? AND connection_id = ? ORDER BY id DESC LIMIT ?').all(terms.id, String(connectionId), n)
      : db.prepare('SELECT * FROM terms_acknowledgements WHERE terms_id = ? ORDER BY id DESC LIMIT ?').all(terms.id, n);
    return rows.map((r) => toRecord(r, terms));
  }

  const clearAll = () => { db.prepare('DELETE FROM terms_acknowledgements').run(); };

  return { current, record, isAccepted, requireAccepted, history, clearAll };
}
