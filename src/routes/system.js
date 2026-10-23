import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { PROJECT_ROOT } from '../config.js';
import { ah, parse } from '../lib/http.js';

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
})();

const cleanupSchema = z.object({
  confirm: z.literal('DELETE'),
  includeMessages: z.boolean().optional(),
}).strict();

/** Mounted at /api: csrf token, health, dashboard overview, full data cleanup. */
export default function systemRouter(ctx, { strictLimiter, csrfToken }) {
  const r = express.Router();

  r.get('/csrf', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ token: csrfToken });
  });

  r.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));

  r.get('/overview', ah(async (_req, res) => {
    const [ai, connectionList] = await Promise.all([ctx.drafts.aiStatus(), ctx.connections.list()]);
    const items = Array.isArray(connectionList) ? connectionList : (connectionList?.items ?? []);
    res.json({
      app: { version: VERSION, chatProvider: ctx.config.chatProvider, testMode: ctx.config.chatProvider === 'test' },
      connections: { total: items.length, connected: items.filter((c) => c.status === 'connected').length },
      scheduler: ctx.scheduler.getStatus(),
      workflows: ctx.schedulers.list().map(({ connection, engine }) => {
        const s = engine.getStatus();
        return { connectionId: connection.id, label: connection.label, provider: connection.provider, connectionStatus: connection.status, state: s.state, stream: s.stream, pendingReview: Boolean(s.pendingReview), today: s.today };
      }),
      messages: ctx.messages.stats(),
      ai,
      recentActivity: ctx.activity.recent(10),
    });
  }));

  r.post('/system/cleanup', strictLimiter, ah(async (req, res) => {
    const body = parse(cleanupSchema, req.body ?? {});
    const { db } = ctx;
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

    ctx.schedulers.stopAll('Data cleanup');
    const connectionCount = count('account_connections');
    await ctx.connections.cleanupAll();

    const removed = {
      connections: connectionCount,
      logs: ctx.activity.clear(),
      drafts: Number(db.prepare('DELETE FROM generated_drafts').run().changes),
      sessions: Number(db.prepare('DELETE FROM sessions').run().changes),
      sendLedger: Number(db.prepare('DELETE FROM send_ledger').run().changes),
      termsAcknowledgements: Number(db.prepare('DELETE FROM terms_acknowledgements').run().changes),
    };
    if (body.includeMessages) removed.messages = Number(db.prepare('DELETE FROM messages').run().changes);
    db.prepare('UPDATE scheduler_settings SET connection_id = NULL, updated_at = ? WHERE id = 1').run(new Date().toISOString());
    ctx.schedulers.deleteAll();
    db.prepare(`UPDATE scheduler_settings SET target_video_id = NULL, target_url = NULL, target_title = NULL, target_channel_title = NULL,
      target_connection_id = NULL, target_validated_at = NULL, target_external = 0, target_acknowledged_at = NULL WHERE id = 1`).run();

    ctx.activity.log({ eventType: 'data.cleanup', level: 'warning', details: { removed } });
    res.json({ ok: true, removed });
  }));

  return r;
}
