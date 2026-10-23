import crypto from 'node:crypto';
import { CATEGORIES, YOUTUBE_MAX_MESSAGE_LENGTH } from '../config.js';
import { AppError, AiProviderError, notFound } from '../errors.js';
import { nowIso, plain, transaction } from '../db/index.js';
import { sanitizeText, normalizeForCompare, validateMessageText } from '../lib/text.js';

const STATUSES = ['pending', 'approved', 'rejected'];
const MAX_REJECTED_TEXT = 300;

const toDraft = (row) => {
  const r = plain(row);
  return r && {
    id: r.id,
    batchId: r.batch_id,
    text: r.text,
    category: r.category,
    tone: r.tone,
    language: r.language,
    provider: r.provider,
    status: r.status,
    duplicateOf: r.duplicate_of ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
  };
};

const uniqueIds = (ids) => [...new Set((ids ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];

/**
 * AI/preset draft review queue. Generated candidates are stored as `pending` drafts and only become
 * library messages when explicitly approved.
 */
export function createDraftsService({ db, activity, messages, aiProvider, presetProvider }) {
  const stmt = {
    get: db.prepare('SELECT * FROM generated_drafts WHERE id = ?'),
    pendingByNormalized: db.prepare("SELECT id FROM generated_drafts WHERE status = 'pending' AND normalized = ? AND id != ?"),
    insert: db.prepare(`INSERT INTO generated_drafts (batch_id, text, normalized, category, tone, language, provider, status, duplicate_of, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`),
    updateText: db.prepare('UPDATE generated_drafts SET text = ?, normalized = ?, duplicate_of = ? WHERE id = ?'),
    decide: db.prepare("UPDATE generated_drafts SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'"),
    setDuplicate: db.prepare('UPDATE generated_drafts SET duplicate_of = ? WHERE id = ?'),
    clearDecided: db.prepare("DELETE FROM generated_drafts WHERE status != 'pending'"),
  };

  const libraryDuplicateId = async (text) => {
    const dup = await messages.findDuplicate(text);
    return dup?.id ?? null;
  };

  const getRow = (id) => {
    const row = stmt.get.get(id);
    if (!row) throw notFound('Draft');
    return plain(row);
  };

  function pickProvider(source) {
    if (source === 'preset') return presetProvider;
    if (source === 'ai') {
      if (!aiProvider.isConfigured()) {
        throw new AppError('NOT_CONFIGURED', 'AI generation is not configured. Set AI_API_KEY (and optionally AI_BASE_URL / AI_MODEL) in .env, or use the preset library.', { status: 400 });
      }
      return aiProvider;
    }
    return aiProvider.isConfigured() ? aiProvider : presetProvider;
  }

  return {
    aiStatus() {
      const configured = Boolean(aiProvider.isConfigured());
      return {
        configured,
        provider: configured ? aiProvider.name : presetProvider.name,
        model: aiProvider.model ?? null,
        baseUrlHost: aiProvider.baseUrlHost ?? null,
      };
    },

    async generate({
      category, tone = 'friendly', count = 5, language = 'en', maxLength = 150, emoji = 'some', length = 'short', source = 'auto',
    } = {}) {
      if (!CATEGORIES.includes(category)) throw new AppError('INVALID_CATEGORY', `Category must be one of: ${CATEGORIES.join(', ')}.`, { status: 400 });
      const n = Math.max(1, Math.min(20, Math.trunc(Number(count)) || 5));
      const limit = Math.max(1, Math.min(YOUTUBE_MAX_MESSAGE_LENGTH, Math.trunc(Number(maxLength)) || 150));
      const provider = pickProvider(source);
      const opts = { category, tone, count: n, language, maxLength: limit, emoji, length };

      let candidates;
      try {
        candidates = await provider.generateMessages(opts);
      } catch (err) {
        activity.log({
          eventType: 'draft.generated', level: 'error', provider: provider.name, category, outcome: 'failed',
          details: { code: err?.code ?? 'UNKNOWN', message: err?.message },
        });
        if (err instanceof AiProviderError || err instanceof AppError) throw err;
        throw new AiProviderError('BAD_RESPONSE', 'The AI provider failed unexpectedly.');
      }
      if (!Array.isArray(candidates)) candidates = [];

      const accepted = [];
      const rejected = [];
      const seen = new Set();
      for (const raw of candidates) {
        if (accepted.length >= n) break;
        if (typeof raw !== 'string') { rejected.push({ text: '', reason: 'Candidate is not text.' }); continue; }
        const shown = sanitizeText(raw).slice(0, MAX_REJECTED_TEXT);
        const check = validateMessageText(raw, { maxLength: limit });
        if (!check.ok) { rejected.push({ text: shown, reason: check.reason }); continue; }
        const normalized = normalizeForCompare(check.text);
        if (seen.has(normalized)) { rejected.push({ text: shown, reason: 'Duplicate within this batch.' }); continue; }
        if (stmt.pendingByNormalized.get(normalized, 0)) { rejected.push({ text: shown, reason: 'Already waiting for review as another draft.' }); continue; }
        seen.add(normalized);
        accepted.push({ text: check.text, normalized, duplicateOf: await libraryDuplicateId(check.text) });
      }

      const batchId = crypto.randomUUID();
      const createdAt = nowIso();
      const ids = transaction(db, () => accepted.map((a) => Number(stmt.insert.run(
        batchId, a.text, a.normalized, category, tone, language, provider.name, a.duplicateOf, createdAt,
      ).lastInsertRowid)));
      const drafts = ids.map((id) => toDraft(stmt.get.get(id)));

      activity.log({
        eventType: 'draft.generated', level: drafts.length ? 'info' : 'warning', provider: provider.name, category,
        outcome: drafts.length ? 'success' : 'empty',
        details: { batchId, generated: drafts.length, rejected: rejected.length, tone, language },
      });
      return { batchId, provider: provider.name, drafts, rejected };
    },

    list({ status = 'pending', batchId } = {}) {
      const where = [];
      const params = [];
      if (status && status !== 'all') {
        if (!STATUSES.includes(status)) throw new AppError('INVALID_STATUS', `Status must be one of: ${STATUSES.join(', ')}, all.`, { status: 400 });
        where.push('status = ?'); params.push(status);
      }
      if (batchId) { where.push('batch_id = ?'); params.push(batchId); }
      const sql = `SELECT * FROM generated_drafts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`;
      return db.prepare(sql).all(...params).map(toDraft);
    },

    async update(id, { text } = {}) {
      const row = getRow(id);
      if (row.status !== 'pending') throw new AppError('DRAFT_NOT_PENDING', `Only pending drafts can be edited (this one is ${row.status}).`, { status: 409 });
      const check = validateMessageText(text);
      if (!check.ok) throw new AppError('INVALID_MESSAGE', check.reason, { status: 400 });
      const normalized = normalizeForCompare(check.text);
      const other = stmt.pendingByNormalized.get(normalized, row.id);
      if (other) throw new AppError('DUPLICATE_DRAFT', 'Another pending draft already has this text.', { status: 409, details: { existingDraftId: other.id } });
      stmt.updateText.run(check.text, normalized, await libraryDuplicateId(check.text), row.id);
      return toDraft(stmt.get.get(row.id));
    },

    async approve(ids) {
      const approved = [];
      const failed = [];
      for (const draftId of uniqueIds(ids)) {
        const row = plain(stmt.get.get(draftId));
        if (!row) { failed.push({ draftId, reason: 'Draft not found.' }); continue; }
        if (row.status !== 'pending') { failed.push({ draftId, reason: `Draft is already ${row.status}.` }); continue; }
        try {
          const message = await messages.create({
            text: row.text, category: row.category, enabled: true, source: row.provider === presetProvider.name ? 'preset' : 'ai',
          });
          stmt.decide.run('approved', nowIso(), draftId);
          approved.push({ draftId, messageId: message.id });
        } catch (err) {
          if (!(err instanceof AppError) || !['DUPLICATE_MESSAGE', 'INVALID_MESSAGE'].includes(err.code)) throw err;
          if (err.code === 'DUPLICATE_MESSAGE' && err.details?.existingId) stmt.setDuplicate.run(err.details.existingId, draftId);
          failed.push({ draftId, reason: err.message });
        }
      }
      if (approved.length || failed.length) {
        activity.log({
          eventType: 'draft.approved', level: failed.length ? (approved.length ? 'warning' : 'error') : 'success',
          outcome: failed.length ? 'partial' : 'success',
          messageId: approved.length === 1 ? approved[0].messageId : undefined,
          details: { approved, failed },
        });
      }
      return { approved, failed };
    },

    reject(ids) {
      const decidedAt = nowIso();
      const list = uniqueIds(ids);
      const rejected = list.length
        ? transaction(db, () => list.reduce((sum, id) => sum + Number(stmt.decide.run('rejected', decidedAt, id).changes), 0))
        : 0;
      if (rejected) activity.log({ eventType: 'draft.rejected', level: 'info', outcome: 'success', details: { rejected, ids: list } });
      return { rejected };
    },

    clearDecided() {
      return Number(stmt.clearDecided.run().changes);
    },
  };
}
