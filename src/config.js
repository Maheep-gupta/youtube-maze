import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** YouTube rejects chat messages longer than 200 characters. */
export const YOUTUBE_MAX_MESSAGE_LENGTH = 200;

export const CATEGORIES = Object.freeze(['compliments', 'sarcasm', 'witty_jokes', 'motivation', 'wholesome']);

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the runtime configuration. Pass overrides in tests instead of mutating process.env.
 * Secrets stay in this object on the server; never serialize it to the browser.
 */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  const port = overrides.port ?? int(env.PORT, 3000);
  const dataDir = path.resolve(PROJECT_ROOT, overrides.dataDir ?? env.DATA_DIR ?? './data');

  return {
    host,
    port,
    publicOrigin: overrides.publicOrigin ?? `http://${host}:${port}`,
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'companion.db'),
    keyPath: overrides.keyPath ?? path.join(dataDir, 'secret.key'),
    tokenEncryptionKey: overrides.tokenEncryptionKey ?? env.TOKEN_ENCRYPTION_KEY ?? '',
    chatProvider: overrides.chatProvider ?? env.CHAT_PROVIDER ?? 'test',
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      ...overrides.google,
    },
    ai: {
      baseUrl: env.AI_BASE_URL ?? 'https://api.openai.com/v1',
      model: env.AI_MODEL ?? 'gpt-4o-mini',
      apiKey: env.AI_API_KEY ?? '',
      timeoutMs: int(env.AI_TIMEOUT_MS, 30000),
      ...overrides.ai,
    },
    rateLimit: {
      windowMs: 60_000,
      max: 300,
      ...overrides.rateLimit,
    },
  };
}
