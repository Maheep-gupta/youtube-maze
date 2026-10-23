import { z } from 'zod';
import { CATEGORIES, YOUTUBE_MAX_MESSAGE_LENGTH } from '../config.js';

/** Tone / language are interpolated into the AI prompt, so restrict them to a conservative charset. */
const promptParam = z.string().trim().min(1).max(40)
  .regex(/^[\p{L}\p{M}\p{N} ,.'&()-]+$/u, 'Only letters, numbers, spaces and basic punctuation are allowed');

export const generateSchema = z.object({
  category: z.enum(CATEGORIES),
  tone: promptParam.default('friendly'),
  count: z.number().int().min(1).max(20).default(5),
  language: promptParam.default('en'),
  maxLength: z.number().int().min(20).max(YOUTUBE_MAX_MESSAGE_LENGTH).default(150),
  emoji: z.enum(['none', 'some', 'lots']).default('some'),
  length: z.enum(['short', 'medium', 'long']).default('short'),
  source: z.enum(['auto', 'ai', 'preset']).default('auto'),
}).strict();

export const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  batchId: z.string().uuid().optional(),
});

export const updateDraftSchema = z.object({
  text: z.string().max(1000),
}).strict();

export const idsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
}).strict();
