import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFetch } from '../helpers.js';
import { createYouTubeProvider, mapYouTubeError } from '../../src/providers/chat/youtubeProvider.js';
import { createTestChatProvider } from '../../src/providers/chat/testProvider.js';
import { assertChatProvider } from '../../src/providers/chat/ChatProvider.js';
import { ChatProviderError } from '../../src/errors.js';

const TOKEN = 'ya29.secret-access-token-abcdef';
const AUTH = { accessToken: TOKEN, channelId: 'UCme' };

const gErr = (status, reason, message = 'upstream message') => ({
  status,
  json: { error: { code: status, message, errors: [{ reason, message }] } },
});

const broadcast = (overrides = {}) => ({
  id: 'b1',
  snippet: { channelId: 'UCme', title: 'My stream', liveChatId: 'chat-1', ...overrides.snippet },
  status: { lifeCycleStatus: 'live', ...overrides.status },
  ...(overrides.id ? { id: overrides.id } : {}),
});

const isBroadcasts = (u) => u.startsWith('https://www.googleapis.com/youtube/v3/liveBroadcasts');
const isInsert = (u, i) => u.startsWith('https://www.googleapis.com/youtube/v3/liveChat/messages') && i.method === 'POST';
const isChannels = (u) => u.startsWith('https://www.googleapis.com/youtube/v3/channels');

describe('youtubeProvider contract', () => {
  test('implements ChatProvider and exposes required scope', () => {
    const p = createYouTubeProvider({ fetch: createMockFetch([]) });
    assertChatProvider(p);
    assert.equal(p.name, 'youtube');
    assert.equal(p.isTestMode, false);
    assert.deepEqual(p.requiredScopes, ['https://www.googleapis.com/auth/youtube.force-ssl']);
  });
});

describe('getActiveBroadcast', () => {
  test('uses broadcastStatus=active&broadcastType=all with bearer auth and returns the owned live broadcast', async () => {
    const fetch = createMockFetch([{ match: isBroadcasts, respond: () => ({ json: { items: [broadcast()] } }) }]);
    const p = createYouTubeProvider({ fetch });
    const b = await p.getActiveBroadcast(AUTH);
    assert.deepEqual(b, { broadcastId: 'b1', liveChatId: 'chat-1', title: 'My stream', channelId: 'UCme', lifeCycleStatus: 'live' });
    const url = new URL(fetch.calls[0].url);
    assert.equal(url.searchParams.get('broadcastStatus'), 'active');
    assert.equal(url.searchParams.get('broadcastType'), 'all');
    assert.equal(url.searchParams.get('part'), 'id,snippet,status');
    assert.equal(url.searchParams.has('mine'), false);
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(fetch.calls[0].init.signal, 'request has a timeout signal');
    assert.ok(!fetch.calls[0].url.includes(TOKEN), 'token never in URL');
  });

  test('not live returns null', async () => {
    const fetch = createMockFetch([{ match: isBroadcasts, respond: () => ({ json: { items: [] } }) }]);
    assert.equal(await createYouTubeProvider({ fetch }).getActiveBroadcast(AUTH), null);
  });

  test('ignores broadcasts not owned by the authorized channel, without chat, or not in live state', async () => {
    const items = [
      broadcast({ id: 'other', snippet: { channelId: 'UCsomeoneElse' } }),
      broadcast({ id: 'nochat', snippet: { liveChatId: undefined } }),
      broadcast({ id: 'testing', status: { lifeCycleStatus: 'testing' } }),
    ];
    const fetch = createMockFetch([{ match: isBroadcasts, respond: () => ({ json: { items } }) }]);
    assert.equal(await createYouTubeProvider({ fetch }).getActiveBroadcast(AUTH), null);
  });

  test('looks up the authorized channel when auth has no channelId', async () => {
    const fetch = createMockFetch([
      { match: isBroadcasts, respond: () => ({ json: { items: [broadcast()] } }) },
      { match: isChannels, respond: () => ({ json: { items: [{ id: 'UCme', snippet: { title: 'Me' } }] } }) },
    ]);
    const b = await createYouTubeProvider({ fetch }).getActiveBroadcast({ accessToken: TOKEN });
    assert.equal(b.broadcastId, 'b1');
    const ch = new URL(fetch.calls.find((c) => isChannels(c.url)).url);
    assert.equal(ch.searchParams.get('mine'), 'true');
  });

  test('missing token -> AUTH_FAILED without any network call', async () => {
    const fetch = createMockFetch([]);
    await assert.rejects(createYouTubeProvider({ fetch }).getActiveBroadcast({}), { code: 'AUTH_FAILED' });
    assert.equal(fetch.calls.length, 0);
  });
});

describe('checkChat', () => {
  const provider = (items) => createYouTubeProvider({ fetch: createMockFetch([{ match: isBroadcasts, respond: () => ({ json: { items } }) }]) });

  test('available when the owned broadcast with that chat is live', async () => {
    assert.deepEqual(await provider([broadcast()]).checkChat(AUTH, 'chat-1'), { available: true });
  });
  test('unavailable when no active broadcast has that chat', async () => {
    const r = await provider([broadcast()]).checkChat(AUTH, 'chat-2');
    assert.equal(r.available, false);
    assert.match(r.reason, /no longer active/);
  });
  test('unavailable when the broadcast is not in live state', async () => {
    const r = await provider([broadcast({ status: { lifeCycleStatus: 'testing' } })]).checkChat(AUTH, 'chat-1');
    assert.equal(r.available, false);
  });
});

describe('getAuthorizedChannel', () => {
  test('returns channel id and title', async () => {
    const fetch = createMockFetch([{ match: isChannels, respond: () => ({ json: { items: [{ id: 'UCme', snippet: { title: 'My Channel' } }] } }) }]);
    assert.deepEqual(await createYouTubeProvider({ fetch }).getAuthorizedChannel(AUTH), { channelId: 'UCme', title: 'My Channel' });
    const url = new URL(fetch.calls[0].url);
    assert.equal(url.searchParams.get('part'), 'snippet');
    assert.equal(url.searchParams.get('mine'), 'true');
  });
  test('no channel -> PERMISSION_DENIED', async () => {
    const fetch = createMockFetch([{ match: isChannels, respond: () => ({ json: { items: [] } }) }]);
    await assert.rejects(createYouTubeProvider({ fetch }).getAuthorizedChannel(AUTH), { code: 'PERMISSION_DENIED' });
  });
});

describe('sendMessage', () => {
  test('posts a textMessageEvent via liveChatMessages.insert and returns the id', async () => {
    const fetch = createMockFetch([{ match: isInsert, respond: () => ({ json: { id: 'msg-123', snippet: { publishedAt: '2026-01-15T12:00:00Z' } } }) }]);
    const r = await createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: '  Great stream!  ' });
    assert.deepEqual(r, { providerMessageId: 'msg-123', publishedAt: '2026-01-15T12:00:00Z' });
    const call = fetch.calls[0];
    assert.equal(new URL(call.url).searchParams.get('part'), 'snippet');
    assert.deepEqual(JSON.parse(call.init.body), {
      snippet: { liveChatId: 'chat-1', type: 'textMessageEvent', textMessageDetails: { messageText: 'Great stream!' } },
    });
  });

  test('a 200 response without an id is NOT success', async () => {
    const fetch = createMockFetch([{ match: isInsert, respond: () => ({ json: { kind: 'youtube#liveChatMessage' } }) }]);
    await assert.rejects(
      createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: 'hello' }),
      (err) => err instanceof ChatProviderError && /no message id/.test(err.message),
    );
  });

  test('a 200 response with a non-JSON body is NOT success', async () => {
    const fetch = createMockFetch([{ match: isInsert, respond: () => ({ text: 'ok' }) }]);
    await assert.rejects(createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: 'hello' }), ChatProviderError);
  });

  test('invalid text is rejected locally without network', async () => {
    const fetch = createMockFetch([]);
    const p = createYouTubeProvider({ fetch });
    await assert.rejects(p.sendMessage(AUTH, { liveChatId: 'chat-1', text: 'x'.repeat(201) }), { code: 'INVALID_MESSAGE' });
    await assert.rejects(p.sendMessage(AUTH, { liveChatId: 'chat-1', text: '   ' }), { code: 'INVALID_MESSAGE' });
    assert.equal(fetch.calls.length, 0);
  });

  test('fetch throwing -> NETWORK (non-fatal)', async () => {
    const fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: 'hi there' }), (err) => err.code === 'NETWORK' && err.fatal === false);
  });

  test('timeout -> NETWORK', async () => {
    const fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    await assert.rejects(createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: 'hi there' }), { code: 'NETWORK' });
  });

  test('401 -> AUTH_FAILED and the token never appears in the error', async () => {
    const fetch = createMockFetch([{ match: isInsert, respond: () => gErr(401, 'authError', `Invalid Credentials Bearer ${TOKEN}`) }]);
    await assert.rejects(createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: 'hi there' }), (err) => {
      assert.equal(err.code, 'AUTH_FAILED');
      assert.equal(err.fatal, true);
      assert.ok(!err.message.includes(TOKEN));
      assert.ok(!JSON.stringify(err).includes(TOKEN));
      return true;
    });
  });
});

describe('YouTube error mapping table', () => {
  const cases = [
    [401, 'authError', 'AUTH_FAILED'],
    [401, undefined, 'AUTH_FAILED'],
    [403, 'quotaExceeded', 'QUOTA_EXCEEDED'],
    [403, 'dailyLimitExceeded', 'QUOTA_EXCEEDED'],
    [403, 'rateLimitExceeded', 'RATE_LIMITED'],
    [429, 'userRateLimitExceeded', 'RATE_LIMITED'],
    [429, undefined, 'RATE_LIMITED'],
    [403, 'liveChatEnded', 'CHAT_UNAVAILABLE'],
    [404, 'liveChatNotFound', 'CHAT_UNAVAILABLE'],
    [403, 'liveChatDisabled', 'CHAT_UNAVAILABLE'],
    [403, 'forbidden', 'PERMISSION_DENIED'],
    [403, 'insufficientPermissions', 'PERMISSION_DENIED'],
    [403, 'userBanned', 'PERMISSION_DENIED'],
    [403, 'insufficientLivePermissions', 'PERMISSION_DENIED'],
    [403, undefined, 'PERMISSION_DENIED'],
    [400, 'messageTextInvalid', 'INVALID_MESSAGE'],
    [400, 'invalidValue', 'INVALID_MESSAGE'],
    [500, 'backendError', 'UNKNOWN'],
  ];
  for (const [status, reason, code] of cases) {
    test(`${status} ${reason ?? '(no reason)'} -> ${code} (via sendMessage)`, async () => {
      const fetch = createMockFetch([{ match: isInsert, respond: () => gErr(status, reason) }]);
      await assert.rejects(createYouTubeProvider({ fetch }).sendMessage(AUTH, { liveChatId: 'chat-1', text: 'hello' }), (err) => {
        assert.ok(err instanceof ChatProviderError);
        assert.equal(err.code, code);
        assert.match(err.message, /upstream message/, 'sanitized upstream message is included');
        return true;
      });
    });
  }

  test('404 notFound on chat requests -> CHAT_UNAVAILABLE', () => {
    assert.equal(mapYouTubeError(404, { error: { errors: [{ reason: 'notFound' }] } }, { chat: true }).code, 'CHAT_UNAVAILABLE');
  });

  test('upstream messages are redacted', () => {
    const err = mapYouTubeError(403, { error: { message: 'leak access_token=ya29.abc123def456 here', errors: [{ reason: 'forbidden' }] } });
    assert.ok(!err.message.includes('ya29.abc123def456'));
  });
});

describe('testProvider (dry run)', () => {
  test('always live, never networked, returns test- ids', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('test provider must not use the network'); };
    try {
      const p = assertChatProvider(createTestChatProvider());
      assert.equal(p.name, 'test');
      assert.equal(p.isTestMode, true);
      const b = await p.getActiveBroadcast({ test: true });
      assert.equal(b.title, 'Test Mode stream (nothing is posted)');
      assert.deepEqual(await p.checkChat({ test: true }, b.liveChatId), { available: true });
      const r1 = await p.sendMessage({ test: true }, { liveChatId: b.liveChatId, text: 'hello' });
      const r2 = await p.sendMessage({ test: true }, { liveChatId: b.liveChatId, text: 'hello again' });
      assert.equal(r1.providerMessageId, 'test-1');
      assert.equal(r2.providerMessageId, 'test-2');
      assert.equal(r1.dryRun, true);
      await assert.rejects(p.sendMessage({ test: true }, { liveChatId: b.liveChatId, text: '' }), { code: 'INVALID_MESSAGE' });
    } finally {
      globalThis.fetch = original;
    }
  });
});
