import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { PROJECT_ROOT } from '../config.js';
import { AppError } from '../errors.js';
import { ah, intId, parse } from '../lib/http.js';
import {
  checkDuplicateSchema, createMessageSchema, importPayloadSchema, listMessagesQuerySchema, updateMessageSchema,
} from '../validation/messages.js';

const SAMPLES_PATH = path.join(PROJECT_ROOT, 'samples', 'messages.sample.json');

/** Mounted at /api/messages. */
export default function messagesRouter(ctx) {
  const r = express.Router();
  const { messages } = ctx;

  r.get('/', ah(async (req, res) => {
    res.json(messages.list(parse(listMessagesQuerySchema, req.query)));
  }));

  r.get('/stats', ah(async (_req, res) => res.json(messages.stats())));

  r.get('/export', ah(async (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="messages-export.json"');
    res.type('application/json').send(JSON.stringify(messages.exportMessages(), null, 2));
  }));

  r.post('/check-duplicate', ah(async (req, res) => {
    const { text, excludeId } = parse(checkDuplicateSchema, req.body);
    const existing = messages.findDuplicate(text, { excludeId });
    res.json(existing ? { duplicate: true, existing } : { duplicate: false });
  }));

  r.post('/import', ah(async (req, res) => {
    res.json(messages.importMessages(parse(importPayloadSchema, req.body)));
  }));

  r.post('/load-samples', ah(async (_req, res) => {
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(SAMPLES_PATH, 'utf8'));
    } catch {
      throw new AppError('SAMPLES_UNAVAILABLE', 'The sample message file is missing or invalid.', { status: 500 });
    }
    res.json(messages.importMessages(payload));
  }));

  r.post('/', ah(async (req, res) => {
    const body = parse(createMessageSchema, req.body);
    res.status(201).json(messages.create({ ...body, source: 'manual' }));
  }));

  r.patch('/:id', ah(async (req, res) => {
    res.json(messages.update(intId(req.params.id), parse(updateMessageSchema, req.body)));
  }));

  r.delete('/:id', ah(async (req, res) => {
    messages.remove(intId(req.params.id));
    res.status(204).end();
  }));

  return r;
}
