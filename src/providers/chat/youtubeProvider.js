import { ChatProviderError } from '../../errors.js';
import { redactString } from '../../logger.js';
import { validateMessageText } from '../../lib/text.js';
import { isValidVideoId } from '../../lib/youtubeUrl.js';

/**
 * YouTube Data API v3 chat provider. Official, documented endpoints only:
 *
 *   channels.list           GET  /channels?part=snippet&mine=true                          quota: 1 unit
 *   liveBroadcasts.list     GET  /liveBroadcasts?part=id,snippet,status
 *                                &broadcastStatus=active&broadcastType=all&maxResults=50     quota: 1 unit
 *   videos.list             GET  /videos?part=snippet,liveStreamingDetails&id=VIDEO_ID       quota: 1 unit
 *   liveChatMessages.list   GET  /liveChat/messages?liveChatId=..&part=id (validate only)    quota: ~5 units
 *   liveChatMessages.insert POST /liveChat/messages?part=snippet                           quota: 20 units
 *
 * Quota costs from https://developers.google.com/youtube/v3/determine_quota_cost (default
 * project quota is 10,000 units/day, i.e. at most ~500 inserts/day before other calls).
 *
 * The selected stream (any channel) is looked up with videos.list: liveBroadcastContent and
 * liveStreamingDetails give live/upcoming/ended and the activeLiveChatId (absent when chat is
 * disabled). For a stream on another channel, validation adds a read-only liveChatMessages.list
 * probe. Neither call proves posting permission: members-only / subscribers-only chats, bans and
 * timeouts surface only when liveChatMessages.insert is refused, and that refusal is reported as a
 * failure, never as success.
 *
 * getActiveBroadcast (connections "Check" only) uses liveBroadcasts.list for the connected
 * channel's own broadcasts. The docs say "specify exactly one of" broadcastStatus / id / mine, so
 * we use broadcastStatus=active&broadcastType=all (includes the "Go live now" persistent
 * broadcast) and keep only broadcasts whose snippet.channelId is the authorized channel.
 *
 * Access tokens are sent only in the Authorization header and never logged or put in errors.
 */
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 15_000;
export const YOUTUBE_SCOPE ='https://www.googleapis.com/auth/youtube.force-ssl';

const REASON_CODES = {
  authError: 'AUTH_FAILED',
  quotaExceeded: 'QUOTA_EXCEEDED',
  dailyLimitExceeded: 'QUOTA_EXCEEDED',
  rateLimitExceeded: 'RATE_LIMITED',
  userRateLimitExceeded: 'RATE_LIMITED',
  liveChatEnded: 'CHAT_UNAVAILABLE',
  liveChatNotFound: 'CHAT_UNAVAILABLE',
  liveChatDisabled: 'CHAT_UNAVAILABLE',
  forbidden: 'PERMISSION_DENIED',
  insufficientPermissions: 'PERMISSION_DENIED',
  insufficientLivePermissions: 'PERMISSION_DENIED',
  liveStreamingNotEnabled: 'PERMISSION_DENIED',
  userBanned: 'PERMISSION_DENIED',
  messageTextInvalid: 'INVALID_MESSAGE',
  messageTextRequired: 'INVALID_MESSAGE',
  invalidValue: 'INVALID_MESSAGE',
};

/** Hints for reasons whose cause is more specific than their code's generic hint. */
const REASON_HINTS = {
  liveStreamingNotEnabled: 'Live streaming is not enabled on the connected channel. Enable it in YouTube Studio (activation can take up to 24 hours).',
  insufficientPermissions: 'The YouTube permission was not granted. Reconnect the account and allow all requested permissions.',
  userBanned: 'The connected account is banned from this live chat.',
};
const CHAT_FORBIDDEN_HINT = 'YouTube refused the post: the chat may be members-only or subscribers-only, the account may be banned or timed out, or the channel restricts who can chat.';

/**
 * Map a Google API error response to a ChatProviderError.
 * @param {number} status HTTP status
 * @param {any} body parsed JSON body (may be {})
 * @param {{ chat?: boolean }} [ctx] chat=true when the request targeted a live chat (404 notFound => chat gone)
 */
export function mapYouTubeError(status, body, { chat = false } = {}) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
  const upstream = redactString(body?.error?.message ?? '').slice(0, 300);
  let code;
  if (status === 401) code = 'AUTH_FAILED';
  else if (reason && REASON_CODES[reason]) code = REASON_CODES[reason];
  else if (chat && (reason === 'notFound' || status === 404)) code = 'CHAT_UNAVAILABLE';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 403) code = 'PERMISSION_DENIED';
  else code = 'UNKNOWN';
  const label = `HTTP ${status}${reason ? ` ${redactString(String(reason)).slice(0, 64)}` : ''}`;
  const err = new ChatProviderError(code, `YouTube API error (${label})${upstream ? `: ${upstream}` : ''}`, { hint: REASON_HINTS[reason] ?? (chat && code === 'PERMISSION_DENIED' ? CHAT_FORBIDDEN_HINT : undefined) });
  err.status = status;
  if (reason) err.reason = String(reason).slice(0, 64);
  return err;
}

export function createYouTubeProvider({ fetch = globalThis.fetch } = {}) {
  async function call(auth, method, path, { query, body, chat = false } = {}) {
    if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) {
      throw new ChatProviderError('AUTH_FAILED', 'No YouTube access token available. Reconnect the account.');
    }
    const url = new URL(`${API_BASE}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? 'request timed out' : 'network error';
      throw new ChatProviderError('NETWORK', `Could not reach the YouTube API (${why}).`);
    }
    let json = {};
    try { json = await res.json(); } catch { json = {}; }
    if (!res.ok) throw mapYouTubeError(res.status, json, { chat });
    return json ?? {};
  }

  async function getAuthorizedChannel(auth) {
    const json = await call(auth, 'GET', '/channels', { query: { part: 'snippet', mine: 'true' } });
    const item = Array.isArray(json.items) ? json.items[0] : undefined;
    if (!item?.id) {
      throw new ChatProviderError('PERMISSION_DENIED', 'This Google account has no YouTube channel. Create a channel first, then reconnect.');
    }
    return { channelId: String(item.id), title: String(item.snippet?.title ?? item.id) };
  }

  async function ownerChannelId(auth) {
    if (typeof auth.channelId === 'string' && auth.channelId) return auth.channelId;
    return (await getAuthorizedChannel(auth)).channelId;
  }

  /** Active broadcasts owned by the authorized channel that have a live chat. */
  async function listOwnedActive(auth) {
    const json = await call(auth, 'GET', '/liveBroadcasts', {
      query: { part: 'id,snippet,status', broadcastStatus: 'active', broadcastType: 'all', maxResults: 50 },
    });
    const items = Array.isArray(json.items) ? json.items : [];
    if (!items.length) return [];
    const owner = await ownerChannelId(auth);
    return items.filter((b) => b?.id && b.snippet?.channelId === owner);
  }

  const toBroadcast = (b) => ({
    broadcastId: String(b.id),
    liveChatId: String(b.snippet.liveChatId),
    title: String(b.snippet.title ?? ''),
    channelId: String(b.snippet.channelId),
    lifeCycleStatus: b.status?.lifeCycleStatus ?? null,
  });

  async function getActiveBroadcast(auth) {
    const owned = await listOwnedActive(auth);
    const live = owned.find((b) => b.snippet?.liveChatId && (b.status?.lifeCycleStatus ?? 'live') === 'live');
    return live ? toBroadcast(live) : null;
  }

  async function checkChat(auth, liveChatId) {
    if (typeof liveChatId !== 'string' || !liveChatId) return { available: false, reason: 'No live chat id.' };
    const owned = await listOwnedActive(auth);
    const b = owned.find((x) => x.snippet?.liveChatId === liveChatId);
    if (!b) return { available: false, reason: 'The broadcast for this chat is no longer active on your channel.' };
    const lifeCycle = b.status?.lifeCycleStatus ?? 'live';
    if (lifeCycle !== 'live') return { available: false, reason: `Broadcast is "${lifeCycle}", not live.` };
    if (b.snippet?.actualEndTime) return { available: false, reason: 'The broadcast has ended.' };
    return { available: true };
  }

  /** videos.list snippet.liveBroadcastContent + liveStreamingDetails -> live | upcoming | ended | none. */
  function videoStatus(v) {
    const d = v.liveStreamingDetails;
    if (!d) return 'none';
    if (d.actualEndTime) return 'ended';
    const content = v.snippet?.liveBroadcastContent;
    if (content === 'live') return 'live';
    if (content === 'upcoming') return 'upcoming';
    return 'ended';
  }

  async function getVideo(auth, videoId, part) {
    const json = await call(auth, 'GET', '/videos', { query: { part, id: videoId } });
    return Array.isArray(json.items) ? json.items.find((v) => v?.id === videoId) : undefined;
  }

  /**
   * Read-only chat probe for a stream on another channel (liveChatMessages.list, ~5 units). It shows
   * whether the connected account can READ the chat; it does NOT prove posting permission
   * (members-only / subscribers-only chats, bans and timeouts surface only on insert).
   */
  async function probeChat(auth, liveChatId) {
    try {
      await call(auth, 'GET', '/liveChat/messages', { query: { liveChatId, part: 'id', maxResults: 200 }, chat: true });
      return { chatReadable: true };
    } catch (err) {
      if (err?.code === 'CHAT_UNAVAILABLE') {
        return {
          chatReadable: false, chatAvailable: false,
          chatReason: err.reason === 'liveChatDisabled' ? 'Live chat is disabled for this stream.' : 'The live chat has ended or no longer exists.',
        };
      }
      if (err?.code === 'PERMISSION_DENIED') {
        return { chatReadable: false, chatAvailable: false, chatReason: 'This chat cannot be accessed by the connected account.' };
      }
      throw err;
    }
  }

  /**
   * The selected livestream, on any channel: videos.list?part=snippet,liveStreamingDetails (1 unit).
   * `owned` says whether the connected channel hosts it. Nothing here proves posting permission for
   * a stream on another channel; that is confirmed only when YouTube accepts a message.
   * checkChat (validate/start only) adds a read-only chat probe for streams on other channels.
   */
  async function getStreamByVideoId(auth, videoId, { checkChat: verifyChat = false } = {}) {
    if (!isValidVideoId(videoId)) throw new ChatProviderError('STREAM_NOT_FOUND', 'Invalid video id.');
    const video = await getVideo(auth, videoId, 'snippet,liveStreamingDetails');
    if (!video) throw new ChatProviderError('STREAM_NOT_FOUND', 'No YouTube video was found for this URL (it may be private, deleted or region-restricted).');
    const status = videoStatus(video);
    const liveChatId = video.liveStreamingDetails?.activeLiveChatId ? String(video.liveStreamingDetails.activeLiveChatId) : null;
    const channelId = String(video.snippet?.channelId ?? '');
    const owned = Boolean(channelId) && channelId === await ownerChannelId(auth);
    const stream = {
      videoId,
      broadcastId: videoId,
      liveChatId,
      title: redactString(String(video.snippet?.title ?? '')).slice(0, 200),
      channelId,
      channelTitle: redactString(String(video.snippet?.channelTitle ?? '')).slice(0, 100),
      status,
      owned,
      chatAvailable: status === 'live' && Boolean(liveChatId),
      chatReadable: null,
    };
    if (status === 'live' && !liveChatId) stream.chatReason = 'Live chat is disabled for this stream.';
    else if (status !== 'live') stream.chatReason = status === 'upcoming' ? 'The stream has not started yet.' : 'The stream is not live.';
    if (stream.chatAvailable) {
      if (owned) stream.chatReadable = true;
      else if (verifyChat) Object.assign(stream, await probeChat(auth, liveChatId));
    }
    return stream;
  }

  const validateMessage = (text) => validateMessageText(text);

  async function sendMessage(auth, { liveChatId, text } = {}) {
    if (typeof liveChatId !== 'string' || !liveChatId) throw new ChatProviderError('CHAT_UNAVAILABLE', 'No live chat id to post to.');
    const v = validateMessage(text);
    if (!v.ok) throw new ChatProviderError('INVALID_MESSAGE', v.reason);
    const json = await call(auth, 'POST', '/liveChat/messages', {
      query: { part: 'snippet' },
      body: { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: v.text } } },
      chat: true,
    });
    // Never fake success: only a returned message resource id counts as "sent".
    if (typeof json?.id !== 'string' || !json.id) {
      throw new ChatProviderError('UNKNOWN', 'YouTube did not confirm the message (response had no message id). It may not have been posted.');
    }
    return { providerMessageId: json.id, publishedAt: json.snippet?.publishedAt ?? new Date().toISOString() };
  }

  return {
    name: 'youtube',
    isTestMode: false,
    requiredScopes: [YOUTUBE_SCOPE],
    getAuthorizedChannel,
    getActiveBroadcast,
    getStreamByVideoId,
    checkChat,
    validateMessage,
    sendMessage,
  };
}
