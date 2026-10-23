import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const config = loadConfig();
if (!LOOPBACK.has(config.host)) {
  logger.warn(`HOST=${config.host} is not a loopback address. The dashboard has no login and is meant for local use only.`);
}

const ctx = createContext(config);
const app = createApp(ctx);

const server = app.listen(config.port, config.host, () => {
  logger.info(`Live Chat Companion running at ${config.publicOrigin}`);
  logger.info(`Chat provider: ${config.chatProvider}${config.chatProvider === 'test' ? ' (TEST MODE: nothing is posted)' : ''}`);
});

server.on('error', (err) => {
  logger.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT in .env.` : `Server error: ${err.message}`);
  process.exit(1);
});

function shutdown(signal) {
  logger.info(`${signal} received, stopping scheduler and closing database.`);
  try { ctx.schedulers.stopAll('Application shutdown'); } catch { /* already stopped */ }
  server.close(() => {
    try { ctx.db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
