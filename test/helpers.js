import crypto from 'node:crypto';
import { openDatabase } from '../src/db/index.js';
import { createCipher } from '../src/security/crypto.js';
import { ChatProviderError } from '../src/errors.js';
import { validateMessageText } from '../src/lib/text.js';

process.env.NODE_ENV = 'test';

export const testDb = () => openDatabase(':memory:');
export const testCipher = () => createCipher(crypto.randomBytes(32));

/**
 * Deterministic clock. Timers fire only when you call advance(ms) / runNext().
 * advance() awaits each fired callback so async scheduler ticks complete.
 */
export function createFakeClock(start = Date.parse('2026-01-15T12:00:00Z')) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, ms) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        timers.delete(id);
        now = t.at;
        await t.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
  };
}

/**
 * Mock chat provider. Never touches the network. Configure behaviour via the returned object:
 *   mock.live = false            -> getActiveBroadcast returns null
 *   mock.failNext('AUTH_FAILED') -> next sendMessage throws that ChatProviderError
 *   mock.sendDelayMs / mock.hold -> make sendMessage slow (for overlap tests)
 *   mock.sent                    -> array of { liveChatId, text } (confirmed sends)
 *   mock.sendCalls               -> array of { auth, liveChatId, text } (every attempt, with the account auth used)
 *   mock.streams[videoId] = {...} -> override getStreamByVideoId for that id (fields merged over the
 *                                   default live stream, owned by the connected channel), e.g.
 *                                   { owned: false, chatReadable: true } for another channel's stream;
 *                                   { error: 'STREAM_NOT_FOUND' } makes it throw.
 *   Without an entry, any id is the default stream ('chat1'), honouring mock.live / mock.chatAvailable.
 *   mock.streamErrorNext('CODE') -> next getStreamByVideoId throws that ChatProviderError
 */
export const MOCK_VIDEO_ID = 'mockVideo01';
export const MOCK_STREAM_URL = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

export function createMockChatProvider(name = 'test') {
  const queue = [];
  const streamQueue = [];
  const mock = {
    name,
    isTestMode: true,
    requiredScopes: [],
    live: true,
    chatAvailable: true,
    streams: {},
    sent: [],
    calls: { getActiveBroadcast: 0, getStreamByVideoId: 0, checkChat: 0, sendMessage: 0 },
    streamCalls: [],
    streamErrorNext(code, message = `mock ${code}`) { streamQueue.push(new ChatProviderError(code, message)); },
    async getStreamByVideoId(_auth, videoId, opts = {}) {
      mock.calls.getStreamByVideoId++;
      mock.streamCalls.push({ videoId, ...opts });
      const queued = streamQueue.shift();
      if (queued) throw queued;
      const base = {
        videoId, broadcastId: 'b1', liveChatId: 'chat1', title: 'Mock stream', channelId: 'UCmock', channelTitle: 'Mock Channel',
        status: mock.live ? 'live' : 'ended', owned: true, chatAvailable: mock.chatAvailable, chatReadable: mock.chatAvailable ? true : null,
        ...(mock.chatAvailable ? {} : { chatReason: 'Chat disabled' }),
      };
      const o = mock.streams[videoId];
      if (o?.error) throw new ChatProviderError(o.error, o.message ?? `mock ${o.error}`);
      return o ? { ...base, ...o } : base;
    },
    hold: null,
    failNext(code, message = `mock ${code}`, { reason } = {}) {
      const err = new ChatProviderError(code, message);
      if (reason) err.reason = reason;
      queue.push(err);
    },
    async getActiveBroadcast() {
      mock.calls.getActiveBroadcast++;
      return mock.live ? { broadcastId: 'b1', liveChatId: 'chat1', title: 'Mock stream', channelId: 'UCmock' } : null;
    },
    async checkChat() {
      mock.calls.checkChat++;
      return mock.chatAvailable ? { available: true } : { available: false, reason: 'Chat disabled' };
    },
    async getAuthorizedChannel() { return { channelId: 'UCmock', title: 'Mock Channel' }; },
    validateMessage: (text) => validateMessageText(text),
    sendCalls: [],
    async sendMessage(auth, { liveChatId, text }) {
      mock.calls.sendMessage++;
      mock.sendCalls.push({ auth, liveChatId, text });
      if (mock.hold) await mock.hold;
      const err = queue.shift();
      if (err) throw err;
      mock.sent.push({ liveChatId, text });
      return { providerMessageId: `m${mock.sent.length}`, publishedAt: new Date().toISOString() };
    },
  };
  return mock;
}

/** Mock AI provider returning canned output (or throwing `error`). */
export function createMockAiProvider({ output = [], error = null, configured = true } = {}) {
  return {
    name: 'mock-ai',
    calls: [],
    isConfigured: () => configured,
    async generateMessages(opts) {
      this.calls.push(opts);
      if (error) throw error;
      return typeof output === 'function' ? output(opts) : output;
    },
  };
}

/** Minimal fetch mock: routes is [{ match: (url, init) => bool, respond: (url, init) => ({ status, json }) }]. */
export function createMockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => r.match(String(url), init));
    if (!route) throw new TypeError(`Unmocked fetch: ${url}`);
    const { status = 200, json = {}, text } = await route.respond(String(url), init);
    const body = text ?? JSON.stringify(json);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
