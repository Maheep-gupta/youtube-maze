/**
 * Application error with an HTTP status and a stable machine-readable code.
 * `message` must be safe to show to the user (no secrets, no raw upstream bodies).
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, { status: 404 });

/**
 * Error codes chat providers may raise. `fatal` codes make the scheduler stop the session.
 */
export const CHAT_ERROR_CODES = Object.freeze({
  AUTH_FAILED: { fatal: true, hint: 'The account authorization expired or was revoked. Reconnect the account.' },
  PERMISSION_DENIED: { fatal: true, hint: 'The account lacks permission to post in this chat (missing youtube.force-ssl scope, banned, or chat restricted).' },
  NOT_LIVE: { fatal: true, hint: 'The selected livestream is not live. Start the stream in YouTube Studio, then try again.' },
  CHAT_UNAVAILABLE: { fatal: true, hint: 'Live chat is disabled or has ended for this stream.' },
  STREAM_NOT_FOUND: { fatal: true, hint: 'No YouTube video exists with this id, or it is private. Check the URL.' },
  QUOTA_EXCEEDED: { fatal: true, hint: 'The YouTube API daily quota is exhausted. It resets at midnight Pacific Time.' },
  NOT_CONFIGURED: { fatal: true, hint: 'The provider is missing configuration (see README: Google Cloud OAuth setup).' },
  RATE_LIMITED: { fatal: false, hint: 'YouTube asked to slow down. The next attempt will wait for the scheduled interval.' },
  INVALID_MESSAGE: { fatal: false, hint: 'The message was rejected as invalid.' },
  NETWORK: { fatal: false, hint: 'A network error occurred contacting the provider.' },
  UNKNOWN: { fatal: false, hint: 'The provider returned an unexpected error.' },
});

export class ChatProviderError extends Error {
  /** `hint` overrides the code's generic hint when the cause is known more precisely. */
  constructor(code, message, { cause, hint } = {}) {
    super(message, { cause });
    this.name = 'ChatProviderError';
    this.code = CHAT_ERROR_CODES[code] ? code : 'UNKNOWN';
    this.fatal = CHAT_ERROR_CODES[this.code].fatal;
    this.hint = hint ?? CHAT_ERROR_CODES[this.code].hint;
  }
}

/**
 * Does this error mean the ACCOUNT connection is broken (vs. one chat refusing it)? A chat that is
 * members-only, bans the account, etc. is a PERMISSION_DENIED for that chat only and must not flag
 * the connection; an expired/revoked grant or a missing OAuth scope does.
 */
export function isAccountError(err) {
  return err?.code === 'AUTH_FAILED' || (err?.code === 'PERMISSION_DENIED' && err?.reason === 'insufficientPermissions');
}

export class AiProviderError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AiProviderError';
    this.code = code; // NOT_CONFIGURED | AUTH_FAILED | RATE_LIMITED | BAD_RESPONSE | NETWORK | TIMEOUT
  }
}
