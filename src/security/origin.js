import crypto from 'node:crypto';
import { AppError } from '../errors.js';

/**
 * Local-app request guards:
 *  - hostGuard: rejects requests whose Host header is not the configured loopback host (DNS rebinding).
 *  - csrfGuard: for state-changing methods, requires a same-origin Origin (or Referer) AND the
 *    per-process CSRF token in the `X-CSRF-Token` header. The browser fetches the token from
 *    GET /api/csrf (same-origin only, so other sites cannot read it).
 */
export function createRequestGuards({ host, port, csrfToken = crypto.randomBytes(32).toString('base64url') }) {
  const allowedHosts = new Set([`${host}:${port}`]);
  if (host === '127.0.0.1') allowedHosts.add(`localhost:${port}`);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  function hostGuard(req, _res, next) {
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
      return next(new AppError('BAD_HOST', 'Request host not allowed.', { status: 403 }));
    }
    next();
  }

  function csrfGuard(req, _res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin ?? originFromReferer(req.headers.referer);
    if (!origin || !allowedOrigins.has(origin)) {
      return next(new AppError('BAD_ORIGIN', 'Cross-origin request rejected.', { status: 403 }));
    }
    const sent = String(req.headers['x-csrf-token'] ?? '');
    if (!timingSafeEqual(sent, csrfToken)) {
      return next(new AppError('BAD_CSRF', 'Missing or invalid CSRF token. Reload the page.', { status: 403 }));
    }
    next();
  }

  return { hostGuard, csrfGuard, csrfToken, allowedOrigins };
}

function originFromReferer(referer) {
  try { return referer ? new URL(referer).origin : undefined; } catch { return undefined; }
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
