import express from 'express';
import { ah, parse, intId } from '../lib/http.js';
import { generateSchema, listQuerySchema, updateDraftSchema, idsSchema } from '../validation/drafts.js';

export default function draftsRouter(ctx, { strictLimiter }) {
  const r = express.Router();

  r.get('/ai-status', (_req, res) => res.json(ctx.drafts.aiStatus()));

  r.post('/generate', strictLimiter, ah(async (req, res) => {
    res.json(await ctx.drafts.generate(parse(generateSchema, req.body ?? {})));
  }));

  r.get('/', (req, res) => {
    res.json({ items: ctx.drafts.list(parse(listQuerySchema, req.query)) });
  });

  r.patch('/:id', ah(async (req, res) => {
    res.json(await ctx.drafts.update(intId(req.params.id), parse(updateDraftSchema, req.body ?? {})));
  }));

  r.post('/approve', ah(async (req, res) => {
    res.json(await ctx.drafts.approve(parse(idsSchema, req.body ?? {}).ids));
  }));

  r.post('/reject', (req, res) => {
    res.json(ctx.drafts.reject(parse(idsSchema, req.body ?? {}).ids));
  });

  r.delete('/', (_req, res) => {
    res.json({ cleared: ctx.drafts.clearDecided() });
  });

  return r;
}
