import { z } from 'zod';

const urlFields = {
  url: z.string().max(2048),
  connectionId: z.string().trim().min(1).max(100).optional(),
};

/** POST /api/stream/validate body. URL syntax is checked by parseYouTubeStreamUrl. */
export const streamUrlBodySchema = z.object(urlFields).strict();

/** POST /api/stream/select body. acknowledgeExternal is required (true) for a stream on another channel. */
export const streamSelectBodySchema = z.object({ ...urlFields, acknowledgeExternal: z.boolean().optional() }).strict();

/** POST /api/workflows/:connectionId/stream/validate body: the account is the path parameter. */
export const workflowStreamValidateSchema = z.object({ url: urlFields.url }).strict();

/** POST /api/workflows/:connectionId/stream/select body. */
export const workflowStreamSelectSchema = z.object({ url: urlFields.url, acknowledgeExternal: z.boolean().optional() }).strict();

/** DELETE /api/stream body (nothing accepted). */
export const streamEmptyBodySchema = z.object({}).strict();
