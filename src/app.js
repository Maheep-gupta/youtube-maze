import express from 'express';
export { errorHandler } from './lib/errorHandler.js';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { AppError } from './errors.js';
import { errorHandler } from './lib/errorHandler.js';
import { createRequestGuards } from './security/origin.js';
import { createRateLimiters } from './security/rateLimit.js';
import systemRouter from './routes/system.js';
import messagesRouter from './routes/messages.js';
import draftsRouter from './routes/drafts.js';
import schedulerRouter from './routes/scheduler.js';
import connectionsRouter from './routes/connections.js';
import oauthRouter from './routes/oauth.js';
import logsRouter from './routes/logs.js';
import streamRouter from './routes/stream.js';
import workflowsRouter from './routes/workflows.js';
import termsRouter from './routes/terms.js';

/**
 * Build the Express app around a context from createContext().
 * Route modules export `default (ctx, { strictLimiter }) => express.Router()`.
 */
export function createApp(ctx) {
  const { config } = ctx;
  const app = express();
  const guards = createRequestGuards({ host: config.host, port: config.port, csrfToken: ctx.csrfToken });
  const limiters = createRateLimiters(config.rateLimit);
  const routeOpts = { strictLimiter: limiters.strict, csrfToken: guards.csrfToken };

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(guards.hostGuard);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://yt3.ggpht.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com",
    });
    next();
  });

  app.use('/api', limiters.api, express.json({ limit: '1mb' }), guards.csrfGuard);
  app.use('/api', systemRouter(ctx, routeOpts));
  app.use('/api/messages', messagesRouter(ctx, routeOpts));
  app.use('/api/drafts', draftsRouter(ctx, routeOpts));
  app.use('/api/scheduler', schedulerRouter(ctx, routeOpts));
  app.use('/api/connections', connectionsRouter(ctx, routeOpts));
  app.use('/api/stream', streamRouter(ctx, routeOpts));
  app.use('/api/workflows', workflowsRouter(ctx, routeOpts));
  app.use('/api/terms', termsRouter(ctx, routeOpts));
  app.use('/api/logs', logsRouter(ctx, routeOpts));
  app.use('/oauth', limiters.api, oauthRouter(ctx, routeOpts));

  // Static files: fixed directory, no dotfiles, no directory listing -> no path traversal.
  app.use(express.static(path.join(PROJECT_ROOT, 'public'), { dotfiles: 'deny', index: 'index.html', fallthrough: true }));

  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', 'API route not found', { status: 404 })));
  app.use(errorHandler);
  return app;
}
