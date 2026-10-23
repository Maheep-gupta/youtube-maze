import { z } from 'zod';

/** POST /api/terms/acknowledgements: the decision on the exact terms version the user was shown. */
export const termsDecisionSchema = z.object({
  connectionId: z.string().trim().min(1).max(100),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'Invalid video id'),
  accepted: z.boolean(),
  termsVersion: z.string().min(1).max(50),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'Invalid terms fingerprint'),
}).strict();

/** GET /api/terms/acknowledgements query. */
export const termsHistoryQuerySchema = z.object({
  connectionId: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
