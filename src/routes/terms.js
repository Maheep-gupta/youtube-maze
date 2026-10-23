import express from 'express';
import { ah, parse } from '../lib/http.js';
import { termsDecisionSchema, termsHistoryQuerySchema } from '../validation/terms.js';

/** Mounted at /api/terms. External Livestream Terms: current text, decisions and history (local only). */
export default function termsRouter(ctx) {
  const r = express.Router();
  const { terms } = ctx;

  r.get('/external-stream', ah(async (_req, res) => res.json(terms.current())));

  r.get('/acknowledgements', ah(async (req, res) => {
    const q = parse(termsHistoryQuerySchema, req.query);
    const t = terms.current();
    res.json({ items: terms.history(q), current: { version: t.version, materialVersion: t.materialVersion } });
  }));

  r.post('/acknowledgements', ah(async (req, res) => {
    res.status(201).json(terms.record(parse(termsDecisionSchema, req.body ?? {})));
  }));

  return r;
}
