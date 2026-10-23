import { z } from 'zod';

export const connectionIdParams = z.object({ id: z.string().uuid() });

export const testConnectionBody = z.object({
  label: z.string().trim().min(1).max(80).optional(),
}).strict();

/**
 * Google's redirect may add extra params (scope, authuser, prompt, hd, iss); unknown keys are
 * stripped, not rejected. Values are bounded to avoid abuse.
 */
export const oauthCallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().min(1).max(256).optional(),
});
