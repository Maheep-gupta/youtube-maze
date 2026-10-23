import express from 'express';
import { ah, parse } from '../lib/http.js';
import { createStreamSelectionService } from '../services/streamSelection.js';
import { schedulerEmptyBodySchema, workflowParams, workflowSettingsPatchSchema } from '../validation/scheduler.js';
import { workflowStreamSelectSchema, workflowStreamValidateSchema } from '../validation/stream.js';

/**
 * Mounted at /api/workflows. One workflow per account connection: its own settings, its own selected
 * livestream and its own start/stop state. The account is always the path parameter; nothing here
 * falls back to another account or stream. Stream validation costs YouTube quota (strict limiter).
 */
export default function workflowsRouter(ctx, { strictLimiter } = {}) {
  const r = express.Router();
  const limit = strictLimiter ? [strictLimiter] : [];
  const { schedulers, connections } = ctx;

  const policy = { concurrentExternalAllowed: false };

  function item(connection, engine) {
    return {
      connectionId: connection.id,
      label: connection.label,
      provider: connection.provider,
      connectionStatus: connection.status,
      settings: engine.getSettings(),
      selection: engine.getSelection(),
      status: engine.getStatus(),
    };
  }

  /** Engine + stream selection pinned to the path's account (404 for an unknown account). */
  function forAccount(req) {
    const { connectionId } = parse(workflowParams, req.params);
    const engine = schedulers.engine(connectionId);
    const streams = createStreamSelectionService({
      scheduler: engine, connections, chatProviders: ctx.chatProviders, activity: ctx.activity, fixedConnectionId: connectionId,
    });
    return { connectionId, engine, streams };
  }

  r.get('/', ah(async (_req, res) => {
    res.json({ items: schedulers.list().map(({ connection, engine }) => item(connection, engine)), policy });
  }));

  r.get('/:connectionId', ah(async (req, res) => {
    const { connectionId, engine } = forAccount(req);
    res.json(item(connections.get(connectionId), engine));
  }));

  r.put('/:connectionId/settings', ah(async (req, res) => {
    const { engine } = forAccount(req);
    res.json(engine.updateSettings(parse(workflowSettingsPatchSchema, req.body ?? {})));
  }));

  r.post('/:connectionId/stream/validate', ...limit, ah(async (req, res) => {
    const { streams } = forAccount(req);
    res.json(await streams.validate(parse(workflowStreamValidateSchema, req.body ?? {})));
  }));
  r.post('/:connectionId/stream/select', ...limit, ah(async (req, res) => {
    const { streams } = forAccount(req);
    res.json(await streams.select(parse(workflowStreamSelectSchema, req.body ?? {})));
  }));
  r.delete('/:connectionId/stream', ah(async (req, res) => {
    const { streams } = forAccount(req);
    parse(schedulerEmptyBodySchema, req.body ?? {});
    res.json(streams.clear());
  }));

  const empty = (req) => parse(schedulerEmptyBodySchema, req.body ?? {});
  r.post('/:connectionId/start', ah(async (req, res) => {
    const { engine } = forAccount(req);
    empty(req);
    res.json(await engine.start());
  }));
  r.post('/:connectionId/pause', ah(async (req, res) => {
    const { engine } = forAccount(req);
    empty(req);
    res.json(engine.pause());
  }));
  r.post('/:connectionId/resume', ah(async (req, res) => {
    const { engine } = forAccount(req);
    empty(req);
    res.json(engine.resume());
  }));
  r.post('/:connectionId/stop', ah(async (req, res) => {
    const { engine } = forAccount(req);
    empty(req);
    res.json(engine.stop('Stopped by user'));
  }));
  r.post('/:connectionId/review/approve', ah(async (req, res) => {
    const { engine } = forAccount(req);
    empty(req);
    res.json(await engine.approveReview());
  }));
  r.post('/:connectionId/review/reject', ah(async (req, res) => {
    const { engine } = forAccount(req);
    empty(req);
    res.json(engine.rejectReview());
  }));

  return r;
}
