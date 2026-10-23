import { rateLimit } from 'express-rate-limit';

/** General limiter for /api. Stricter limiter for expensive or sensitive routes (AI generation, OAuth). */
export function createRateLimiters({ windowMs, max }) {
  const handler = (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again shortly.' } });
  return {
    api: rateLimit({ windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, handler }),
    strict: rateLimit({ windowMs, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, handler }),
  };
}
