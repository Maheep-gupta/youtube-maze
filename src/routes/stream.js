import express from 'express';
import { ah, parse } from '../lib/http.js';
import { streamEmptyBodySchema, streamSelectBodySchema, streamUrlBodySchema } from '../validation/stream.js';

/** Mounted at /api/stream. Validation calls cost YouTube quota, so they use the strict limiter. */
export default function streamRouter(ctx, { strictLimiter } = {}) {
  const r = express.Router();
  const limit = strictLimiter ? [strictLimiter] : [];
  const { streamSelection } = ctx;

  r.get('/', ah(async (_req, res) => res.json(streamSelection.get())));
  r.post('/validate', ...limit, ah(async (req, res) => {
    res.json(await streamSelection.validate(parse(streamUrlBodySchema, req.body ?? {})));
  }));
  r.post('/select', ...limit, ah(async (req, res) => {
    res.json(await streamSelection.select(parse(streamSelectBodySchema, req.body ?? {})));
  }));
  r.delete('/', ah(async (req, res) => {
    parse(streamEmptyBodySchema, req.body ?? {});
    res.json(streamSelection.clear());
  }));

  return r;
}
