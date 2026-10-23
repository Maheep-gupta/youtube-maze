import { ChatProviderError } from '../../errors.js';
import { validateMessageText } from '../../lib/text.js';
import { isValidVideoId } from '../../lib/youtubeUrl.js';

/**
 * Test Mode chat provider: a DRY RUN. It simulates an always-live broadcast so the scheduler and
 * dashboard can be exercised end to end, but it never performs network I/O and nothing is posted
 * anywhere. Message ids it returns are prefixed `test-` so they can't be mistaken for real posts.
 */
export const TEST_BROADCAST = Object.freeze({
  broadcastId: 'test-broadcast',
  liveChatId: 'test-live-chat',
  title: 'Test Mode stream (nothing is posted)',
  channelId: 'UCtest-mode',
});

export function createTestChatProvider() {
  let seq = 0;
  return {
    name: 'test',
    isTestMode: true,
    dryRun: true,
    requiredScopes: [],
    async getAuthorizedChannel() {
      return { channelId: TEST_BROADCAST.channelId, title: 'Test Mode channel' };
    },
    async getActiveBroadcast() {
      return { ...TEST_BROADCAST };
    },
    /** Any well-formed video id is a simulated live stream with chat (dry run, no network). */
    async getStreamByVideoId(_auth, videoId) {
      if (!isValidVideoId(videoId)) throw new ChatProviderError('STREAM_NOT_FOUND', 'Invalid video id.');
      return {
        videoId,
        broadcastId: videoId,
        liveChatId: TEST_BROADCAST.liveChatId,
        title: `${TEST_BROADCAST.title} [${videoId}]`,
        channelId: TEST_BROADCAST.channelId,
        channelTitle: 'Test Mode channel',
        status: 'live',
        owned: true,
        chatAvailable: true,
        chatReadable: true,
      };
    },
    async checkChat(_auth, liveChatId) {
      return liveChatId === TEST_BROADCAST.liveChatId
        ? { available: true }
        : { available: false, reason: 'Unknown test chat id.' };
    },
    validateMessage: (text) => validateMessageText(text),
    async sendMessage(_auth, { liveChatId, text } = {}) {
      if (liveChatId !== TEST_BROADCAST.liveChatId) throw new ChatProviderError('CHAT_UNAVAILABLE', 'Unknown test chat id.');
      const v = validateMessageText(text);
      if (!v.ok) throw new ChatProviderError('INVALID_MESSAGE', v.reason);
      seq += 1;
      // Dry run: nothing leaves this process.
      return { providerMessageId: `test-${seq}`, publishedAt: new Date().toISOString(), dryRun: true };
    },
  };
}
