import { z } from 'zod';
import { CATEGORIES } from '../config.js';

// Length/content rules (200 visible chars, no links, ...) are enforced by the messages service via
// lib/text.js so every entry point shares one rule set; this cap only bounds request size.
const text = z.string().max(2000);
const category = z.enum(CATEGORIES);

/** Accepts true/false/1/0 query strings (z.coerce.boolean would treat "false" as true). */
const queryBool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const createMessageSchema = z.object({
  text,
  category,
  enabled: z.boolean().optional(),
}).strict();

export const updateMessageSchema = z.object({
  text: text.optional(),
  category: category.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one of text, category, enabled.' });

export const checkDuplicateSchema = z.object({
  text,
  excludeId: z.number().int().positive().optional(),
}).strict();

export const listMessagesQuerySchema = z.object({
  category: category.optional(),
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  enabled: queryBool.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Import payload shape is validated in detail by messages.importMessages(). */
export const importPayloadSchema = z.union([z.array(z.unknown()), z.record(z.unknown())]);
