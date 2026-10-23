import { AppError } from '../errors.js';
import { logger, redact } from '../logger.js';

/** Uniform JSON error shape: { error: { code, message, details? } }. Never leaks stack traces. */
export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.parse.failed') err = new AppError('INVALID_JSON', 'Request body is not valid JSON.');
  if (err?.type === 'entity.too.large') err = new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large.', { status: 413 });
  if (err?.name === 'ZodError') {
    err = new AppError('VALIDATION_FAILED', 'Request validation failed.', {
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const isApp = err instanceof AppError || err?.name === 'ChatProviderError' || err?.name === 'AiProviderError';
  const status = err instanceof AppError ? err.status : isApp ? 502 : 500;
  if (!isApp) logger.error(`Unhandled error on ${req.method} ${req.path}`, redact(err));
  const body = {
    error: {
      code: isApp ? err.code : 'INTERNAL_ERROR',
      message: isApp ? redact(err.message) : 'An unexpected error occurred. Check the server console.',
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.details ? { details: redact(err.details) } : {}),
    },
  };
  if (req.path.startsWith('/oauth')) {
    return res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><title>Authorization failed</title><p>${escapeHtml(body.error.message)}</p><p><a href="/#connections">Back to dashboard</a></p>`);
  }
  res.status(status).json(body);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
