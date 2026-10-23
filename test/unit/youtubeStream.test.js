import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFetch } from '../helpers.js';
import { createYouTubeProvider } from '../../src/providers/chat/youtubeProvider.js';
import { createTestChatProvider } from '../../src/providers/chat/testProvider.js';
import { isAccountError } from '../../src/errors.js';

const TOKEN = 'ya29.secret-access-token-abcdef';
const AUTH = { accessToken: TOKEN, channelId: 'UCme' };
const VID = 'abcdefghijk';

const isVideos = (u) => u.startsWith('https://www.googleapis.com/youtube/v3/videos');
const isChatList = (u, init) => u.startsWith('https://www.googleapis.com/youtube/v3/liveChat/messages') && (init.method ?? 'GET') === 'GET';
const isChatInsert = (u, init) => u.startsWith('https://www.googleapis.com/youtube/v3/liveChat/messages') && init.method === 'POST';
const isBroadcasts = (u) => u.startsWith('https://www.googleapis.com/youtube/v3/liveBroadcasts');

const gErr = (status, reason) => ({ status, json: { error: { code: status, message: 'upstream', errors: [{ reason, message: 'upstream' }] } } });

/** videos.list item. live=true -> liveBroadcastContent 'live' with an activeLiveChatId (unless chat=false). */
const video = ({ channelId = 'UCme', channelTitle = 'My Channel', content = 'live', chat = true, ended = false, details = true } = {}) => ({
  id: VID,
  snippet: { channelId, channelTitle, title: 'A stream', liveBroadcastContent: content },
  ...(details ? {
    liveStreamingDetails: {
      ...(chat && content === 'live' && !ended ? { activeLiveChatId: 'chat-1' } : {}),
      ...(ended ? { actualEndTime: '2026-01-01T00:00:00Z' } : {}),
    },
  } : {}),
});
const videos = (item) => ({ match: isVideos, respond: () => ({ json: { items: item ? [item] : [] } }) });
const provider = (routes) => {
  const fetch = createMockFetch(routes);
  return { p: createYouTubeProvider({ fetch }), fetch };
};

describe('youtubeProvider.getStreamByVideoId (the selected livestream, any channel)', () => {
  test('own live stream: one videos.list call, no chat probe, owned + readable', async () => {
    const { p, fetch } = provider([videos(video())]);
    const s = await p.getStreamByVideoId(AUTH, VID, { checkChat: true });
    assert.deepEqual(s, {
      videoId: VID, broadcastId: VID, liveChatId: 'chat-1', title: 'A stream', channelId: 'UCme',
      channelTitle: 'My Channel', status: 'live', owned: true, chatAvailable: true, chatReadable: true,
    });
    assert.equal(fetch.calls.length, 1);
    const u = new URL(fetch.calls[0].url);
    assert.equal(u.searchParams.get('id'), VID);
    assert.equal(u.searchParams.get('part'), 'snippet,liveStreamingDetails');
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!fetch.calls.some((c) => isBroadcasts(c.url)), 'never asks for "any active broadcast"');
  });

  test('stream on another channel: owned false, read-only chat probe on the exact chat id', async () => {
    const { p, fetch } = provider([
      videos(video({ channelId: 'UCother', channelTitle: 'Someone Else' })),
      { match: isChatList, respond: () => ({ json: { items: [] } }) },
    ]);
    const s = await p.getStreamByVideoId(AUTH, VID, { checkChat: true });
    assert.equal(s.owned, false);
    assert.equal(s.channelTitle, 'Someone Else');
    assert.equal(s.status, 'live');
    assert.equal(s.chatAvailable, true);
    assert.equal(s.chatReadable, true);
    const probe = fetch.calls.find((c) => isChatList(c.url, c.init));
    assert.equal(new URL(probe.url).searchParams.get('liveChatId'), 'chat-1');
    assert.ok(!fetch.calls.some((c) => isChatInsert(c.url, c.init)), 'validation never posts');
  });

  test('another channel, chat probe forbidden -> chatReadable false, chat not available, account not at fault', async () => {
    const { p } = provider([
      videos(video({ channelId: 'UCother' })),
      { match: isChatList, respond: () => gErr(403, 'forbidden') },
    ]);
    const s = await p.getStreamByVideoId(AUTH, VID, { checkChat: true });
    assert.equal(s.chatReadable, false);
    assert.equal(s.chatAvailable, false);
    assert.match(s.chatReason, /cannot be accessed/);
  });

  test('another channel, probe says liveChatDisabled -> chat not available with reason', async () => {
    const { p } = provider([
      videos(video({ channelId: 'UCother' })),
      { match: isChatList, respond: () => gErr(403, 'liveChatDisabled') },
    ]);
    const s = await p.getStreamByVideoId(AUTH, VID, { checkChat: true });
    assert.equal(s.chatAvailable, false);
    assert.match(s.chatReason, /disabled/);
  });

  test('another channel, probe quota error propagates (not hidden)', async () => {
    const { p } = provider([
      videos(video({ channelId: 'UCother' })),
      { match: isChatList, respond: () => gErr(403, 'quotaExceeded') },
    ]);
    await assert.rejects(p.getStreamByVideoId(AUTH, VID, { checkChat: true }), { code: 'QUOTA_EXCEEDED' });
  });

  test('without checkChat: exactly one API call (1 quota unit per tick), no probe; chatReadable null for other channels', async () => {
    const { p, fetch } = provider([videos(video({ channelId: 'UCother' }))]);
    const s = await p.getStreamByVideoId(AUTH, VID);
    assert.equal(s.status, 'live');
    assert.equal(s.chatReadable, null);
    assert.equal(fetch.calls.length, 1);
  });

  test('live but chat disabled (no activeLiveChatId) -> chatAvailable false with a reason', async () => {
    const { p, fetch } = provider([videos(video({ channelId: 'UCother', chat: false }))]);
    const s = await p.getStreamByVideoId(AUTH, VID, { checkChat: true });
    assert.equal(s.status, 'live');
    assert.equal(s.liveChatId, null);
    assert.equal(s.chatAvailable, false);
    assert.match(s.chatReason, /disabled/i);
    assert.equal(fetch.calls.length, 1, 'no probe without a chat id');
  });

  for (const [label, item, expected] of [
    ['upcoming', video({ content: 'upcoming' }), 'upcoming'],
    ['ended (actualEndTime)', video({ content: 'none', ended: true }), 'ended'],
    ['ended even if still flagged live', video({ content: 'live', ended: true }), 'ended'],
    ['past livestream without end time', video({ content: 'none' }), 'ended'],
    ['ordinary video (no liveStreamingDetails)', video({ content: 'none', details: false }), 'none'],
  ]) {
    test(`status: ${label} -> ${expected}, never chatAvailable`, async () => {
      const { p } = provider([videos(item)]);
      const s = await p.getStreamByVideoId(AUTH, VID, { checkChat: true });
      assert.equal(s.status, expected);
      assert.equal(s.chatAvailable, false);
      assert.ok(s.chatReason);
    });
  }

  test('video does not exist / not visible -> STREAM_NOT_FOUND', async () => {
    const { p } = provider([videos(null)]);
    await assert.rejects(p.getStreamByVideoId(AUTH, VID), { code: 'STREAM_NOT_FOUND' });
  });

  test('ownership is checked via channels.list when the connection has no stored channel id', async () => {
    const { p } = provider([
      videos(video({ channelId: 'UCme' })),
      { match: (u) => u.includes('/channels'), respond: () => ({ json: { items: [{ id: 'UCme', snippet: { title: 'Me' } }] } }) },
    ]);
    const s = await p.getStreamByVideoId({ accessToken: TOKEN }, VID);
    assert.equal(s.owned, true);
  });

  test('HTTP errors: 401 AUTH_FAILED, 403 insufficientPermissions PERMISSION_DENIED, quotaExceeded QUOTA_EXCEEDED; token never leaked', async () => {
    for (const [resp, code] of [[gErr(401, 'authError'), 'AUTH_FAILED'], [gErr(403, 'insufficientPermissions'), 'PERMISSION_DENIED'], [gErr(403, 'quotaExceeded'), 'QUOTA_EXCEEDED']]) {
      const { p } = provider([{ match: isVideos, respond: () => resp }]);
      await assert.rejects(p.getStreamByVideoId(AUTH, VID), (err) => {
        assert.equal(err.code, code);
        assert.ok(!err.message.includes(TOKEN));
        return true;
      });
    }
  });

  test('malformed video id is rejected without any network call', async () => {
    const { p, fetch } = provider([]);
    await assert.rejects(p.getStreamByVideoId(AUTH, '../../x'), { code: 'STREAM_NOT_FOUND' });
    assert.equal(fetch.calls.length, 0);
  });
});

describe('posting errors on a chat', () => {
  test('forbidden on insert -> PERMISSION_DENIED with a chat-specific hint; not an account error', async () => {
    const { p } = provider([{ match: isChatInsert, respond: () => gErr(403, 'forbidden') }]);
    await assert.rejects(p.sendMessage(AUTH, { liveChatId: 'chat-1', text: 'Hello there' }), (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      assert.equal(err.fatal, true);
      assert.match(err.hint, /members-only|subscribers-only/);
      assert.equal(isAccountError(err), false);
      return true;
    });
  });

  test('isAccountError: AUTH_FAILED and missing scope flag the account; chat refusals do not', () => {
    assert.equal(isAccountError({ code: 'AUTH_FAILED' }), true);
    assert.equal(isAccountError({ code: 'PERMISSION_DENIED', reason: 'insufficientPermissions' }), true);
    assert.equal(isAccountError({ code: 'PERMISSION_DENIED', reason: 'userBanned' }), false);
    assert.equal(isAccountError({ code: 'PERMISSION_DENIED', reason: 'forbidden' }), false);
    assert.equal(isAccountError({ code: 'RATE_LIMITED' }), false);
  });

  test('liveStreamingNotEnabled elsewhere keeps PERMISSION_DENIED but with a specific hint', async () => {
    const { p } = provider([{ match: isBroadcasts, respond: () => gErr(403, 'liveStreamingNotEnabled') }]);
    await assert.rejects(p.getActiveBroadcast(AUTH), (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      assert.match(err.hint, /Live streaming is not enabled/);
      return true;
    });
  });
});

describe('testProvider.getStreamByVideoId', () => {
  test('any valid id is a simulated live stream it owns, with chat; invalid id rejected', async () => {
    const t = createTestChatProvider();
    const s = await t.getStreamByVideoId({ test: true }, VID);
    assert.equal(s.status, 'live');
    assert.equal(s.owned, true);
    assert.equal(s.liveChatId, 'test-live-chat');
    assert.equal(s.chatAvailable, true);
    await assert.rejects(t.getStreamByVideoId({ test: true }, 'nope'), { code: 'STREAM_NOT_FOUND' });
  });
});
