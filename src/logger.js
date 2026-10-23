/**
 * Secret redaction and a tiny console logger. Everything written to the console,
 * the activity log, or an export must pass through `redact`.
 */

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|refresh|access|code_verifier|client_secret|encryption)/i;

const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED_GOOGLE_TOKEN]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED_REFRESH_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
  [/\bGOCSPX-[A-Za-z0-9_-]+/g, '[REDACTED_CLIENT_SECRET]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED_API_KEY]'],
  [/([?&](?:access_token|refresh_token|code|client_secret|key|api_key|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/("?(?:access_token|refresh_token|id_token|client_secret|api_key|apiKey|password)"?\s*[:=]\s*"?)[^",\s}&]+/gi, '$1[REDACTED]'],
];

const extraSecrets = new Set();

/** Register a literal secret value (e.g. the configured API key) so it is always masked. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) extraSecrets.add(value);
}

export function redactString(input) {
  let out = String(input);
  for (const secret of extraSecrets) out = out.split(secret).join('[REDACTED]');
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Deep-redact strings, sensitive keys, and Error objects. Returns a new value. */
export function redact(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return redact({ name: value.name, code: value.code, message: value.message }, depth + 1);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) && v != null && typeof v !== 'boolean' && typeof v !== 'number' ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function write(level, msg, meta) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${redactString(msg)}`;
  const args = meta === undefined ? [line] : [line, JSON.stringify(redact(meta))];
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...args);
}

export const logger = {
  silent: process.env.NODE_ENV === 'test',
  info(msg, meta) { if (!this.silent) write('info', msg, meta); },
  warn(msg, meta) { if (!this.silent) write('warn', msg, meta); },
  error(msg, meta) { if (!this.silent) write('error', msg, meta); },
};
