import express from 'express';
import { ah, parse } from '../lib/http.js';
import { schedulerEmptyBodySchema, schedulerSettingsPatchSchema, schedulerStartSchema } from '../validation/scheduler.js';

/** Mounted at /api/scheduler. */
export default function schedulerRouter(ctx) {
  const r = express.Router();
  const { scheduler } = ctx;

  r.get('/status', ah(async (_req, res) => res.json(scheduler.getStatus())));
  r.get('/settings', ah(async (_req, res) => res.json(scheduler.getSettings())));
  r.put('/settings', ah(async (req, res) => {
    res.json(scheduler.updateSettings(parse(schedulerSettingsPatchSchema, req.body)));
  }));

  r.post('/start', ah(async (req, res) => {
    res.json(await scheduler.start(parse(schedulerStartSchema, req.body ?? {})));
  }));
  r.post('/pause', ah(async (req, res) => {
    parse(schedulerEmptyBodySchema, req.body ?? {});
    res.json(scheduler.pause());
  }));
  r.post('/resume', ah(async (req, res) => {
    parse(schedulerEmptyBodySchema, req.body ?? {});
    res.json(scheduler.resume());
  }));
  r.post('/stop', ah(async (req, res) => {
    parse(schedulerEmptyBodySchema, req.body ?? {});
    res.json(scheduler.stop('Stopped by user'));
  }));

  r.post('/review/approve', ah(async (req, res) => {
    parse(schedulerEmptyBodySchema, req.body ?? {});
    res.json(await scheduler.approveReview());
  }));
  r.post('/review/reject', ah(async (req, res) => {
    parse(schedulerEmptyBodySchema, req.body ?? {});
    res.json(scheduler.rejectReview());
  }));

  return r;
}
