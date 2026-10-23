import { z } from 'zod';
import { CATEGORIES } from '../config.js';

const int = (min, max) => z.number().int().min(min).max(max);

/** Settings of one account's workflow (no account field: the workflow IS the account's). */
const workflowFields = {
  intervalSeconds: int(30, 3600),
  minDelaySeconds: int(10, 3600),
  maxMessagesPerSession: int(1, 500),
  dailyLimit: int(1, 2000).nullable(),
  categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length * 2)
    .transform((list) => [...new Set(list)]),
  maxConsecutiveFailures: int(1, 10),
  reviewMode: z.boolean(),
};

/** Legacy single-scheduler settings: the workflow fields plus the "default workflow" account. */
const settingsFields = {
  ...workflowFields,
  connectionId: z.string().trim().min(1).max(100).nullable(),
};

const minDelayRule = [
  (s) => s.minDelaySeconds <= s.intervalSeconds,
  { message: 'minDelaySeconds must be less than or equal to intervalSeconds', path: ['minDelaySeconds'] },
];

/** Complete workflow settings (used by the scheduler engine after merging a patch). */
export const workflowSettingsSchema = z.object(workflowFields).strict().refine(...minDelayRule);

/** PUT /api/workflows/:connectionId/settings body: any subset of the workflow settings. */
export const workflowSettingsPatchSchema = z.object(workflowFields).partial().strict();

/** Complete legacy settings object. */
export const schedulerSettingsSchema = z.object(settingsFields).strict().refine(...minDelayRule);

/** PUT /api/scheduler/settings body: any subset of the settings. */
export const schedulerSettingsPatchSchema = z.object(settingsFields).partial().strict();

/** POST /api/scheduler/start body. */
export const schedulerStartSchema = z.object({
  connectionId: z.string().trim().min(1).max(100).optional(),
}).strict();

/** POST /api/scheduler/pause|resume|stop bodies (nothing accepted). */
export const schedulerEmptyBodySchema = z.object({}).strict();

/** /api/workflows/:connectionId path params. */
export const workflowParams = z.object({ connectionId: z.string().trim().min(1).max(100) }).strict();
