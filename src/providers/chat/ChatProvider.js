/**
 * Chat provider contract. The scheduler and routes depend only on this shape, never on
 * a concrete implementation. Providers are stateless with respect to credentials: callers
 * pass an `auth` object obtained from connectionsService.getAuth(connectionId).
 *
 * Every method that fails MUST throw ChatProviderError (src/errors.js) with a code from
 * CHAT_ERROR_CODES. `sendMessage` MUST only resolve when the provider confirmed the post
 * (e.g. YouTube returned a message resource id). Never fabricate success.
 *
 * @typedef {{ accessToken: string, channelId?: string } | { test: true }} ChatAuth  - channelId is used for the ownership check
 *
 * @typedef {object} Broadcast
 * @property {string} broadcastId
 * @property {string} liveChatId
 * @property {string} title
 * @property {string} channelId   - owner channel of the broadcast
 *
 * @typedef {object} Stream
 * @property {string} videoId
 * @property {string} broadcastId
 * @property {string|null} liveChatId
 * @property {string} title
 * @property {string} channelId
 * @property {string} channelTitle
 * @property {'live'|'upcoming'|'ended'|'none'} status
 * @property {boolean} owned           - hosted by the authorized channel
 * @property {boolean} chatAvailable   - live with an active chat id (and, if probed, readable)
 * @property {boolean|null} chatReadable - read-only probe result; null when not checked. Never proof of posting permission.
 * @property {string} [chatReason]
 *
 * @typedef {object} ChatProvider
 * @property {string} name                                    - 'youtube' | 'test'
 * @property {boolean} isTestMode                             - true if nothing is ever posted
 * @property {string[]} requiredScopes
 * @property {(auth: ChatAuth) => Promise<Broadcast|null>} getActiveBroadcast
 *           Active broadcast OWNED by the authorized channel (YouTube: liveBroadcasts.list?broadcastStatus=active&broadcastType=all, filtered by snippet.channelId).
 *           Returns null when not live.
 * @property {(auth: ChatAuth, videoId: string, opts?: { checkChat?: boolean }) => Promise<Stream>} getStreamByVideoId
 *           The ONE selected livestream, on any channel (YouTube: videos.list). Throws STREAM_NOT_FOUND when no
 *           such video is visible. checkChat=true adds a read-only chat probe for streams on other channels
 *           (YouTube: liveChatMessages.list). Posting permission is only ever confirmed by sendMessage.
 * @property {(auth: ChatAuth, liveChatId: string) => Promise<{ available: boolean, reason?: string }>} checkChat
 * @property {(text: string) => { ok: true, text: string } | { ok: false, reason: string }} validateMessage
 * @property {(auth: ChatAuth, args: { liveChatId: string, text: string }) => Promise<{ providerMessageId: string, publishedAt: string }>} sendMessage
 */

export const CHAT_PROVIDER_METHODS = ['getActiveBroadcast', 'getStreamByVideoId', 'checkChat', 'validateMessage', 'sendMessage'];

/** Throws if `provider` does not implement the contract. */
export function assertChatProvider(provider) {
  for (const m of CHAT_PROVIDER_METHODS) {
    if (typeof provider?.[m] !== 'function') throw new TypeError(`Chat provider is missing ${m}()`);
  }
  if (typeof provider.name !== 'string') throw new TypeError('Chat provider is missing name');
  return provider;
}
