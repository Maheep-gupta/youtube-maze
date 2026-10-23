import { z } from 'zod';
import { ACTIVITY_GROUPS, ACTIVITY_LEVELS } from '../services/activity.js';

const level = z.enum(ACTIVITY_LEVELS);
const group = z.enum(Object.keys(ACTIVITY_GROUPS));

export const listLogsQuerySchema = z.object({
  level: level.optional(),
  group: group.optional(),
  sessionId: z.string().trim().min(1).max(100).optional(),
  connectionId: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
});

export const exportLogsQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  level: level.optional(),
  group: group.optional(),
  connectionId: z.string().trim().min(1).max(100).optional(),
});

export const clearLogsSchema = z.object({ confirm: z.literal(true) }).strict();
