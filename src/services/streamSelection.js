import { AppError, ChatProviderError, isAccountError } from '../errors.js';
import { redactString } from '../logger.js';
import { parseYouTubeStreamUrl } from '../lib/youtubeUrl.js';

const ERROR_STATUS = {
  STREAM_NOT_FOUND: 404, AUTH_FAILED: 400, PERMISSION_DENIED: 403,
  QUOTA_EXCEEDED: 429, RATE_LIMITED: 429, CHAT_UNAVAILABLE: 409, NOT_CONFIGURED: 400,
};

const UNVERIFIED_POSTING = 'Posting permission cannot be verified in advance; it is confirmed only when YouTube accepts the first message.';

/**
 * Livestream selection: validates a YouTube URL (a stream on the connected channel or on another
 * channel) and stores the choice on the scheduler. Knowing a URL never grants permission to post: for
 * a stream on another channel, posting permission stays "unverified" until YouTube accepts a message,
 * and selecting it requires an explicit acknowledgement. The scheduler refuses changes while a session
 * is running or paused.
 */
export function createStreamSelectionService({ scheduler, connections, chatProviders, activity, fixedConnectionId = null }) {
  /**
   * The account a workflow route is pinned to (fixedConnectionId), else the explicit id, else the
   * scheduler's saved account, else the only connected account (never a guess among several).
   */
  function resolveConnection(connectionId) {
    if (fixedConnectionId) connectionId = fixedConnectionId;
    let id = connectionId ?? scheduler.getSettings().connectionId;
    if (!id) {
      const connected = connections.list().filter((c) => c.status === 'connected');
      if (connected.length === 1) id = connected[0].id;
    }
    if (!id) throw new AppError('NO_CONNECTION', 'Select a sending account in Scheduler settings (or connect one) before validating a stream.', { status: 400 });
    const connection = connections.get(id); // 404 if unknown
    const provider = chatProviders[connection.provider];
    if (!provider) throw new AppError('NOT_CONFIGURED', `Chat provider "${connection.provider}" is not available.`, { status: 400 });
    return { id, connection, provider };
  }

  function toAppError(raw, connectionId) {
    if (raw instanceof AppError) return raw;
    const err = raw instanceof ChatProviderError || raw?.name === 'ChatProviderError'
      ? raw
      : new ChatProviderError('UNKNOWN', redactString(raw?.message ?? 'Unexpected provider error'));
    if (isAccountError(err)) { try { connections.markError(connectionId, err); } catch { /* gone */ } }
    const appErr = new AppError(err.code, err.message, { status: ERROR_STATUS[err.code] ?? 502 });
    appErr.hint = err.hint;
    return appErr;
  }

  function describe(stream) {
    const external = !stream.owned;
    const posting = external ? ` ${UNVERIFIED_POSTING}` : '';
    if (stream.status === 'live') {
      if (!stream.chatAvailable) {
        return { status: 'live', canConnect: false, message: `The stream is live, but chat is unavailable: ${stream.chatReason ?? 'chat disabled'}.` };
      }
      return {
        status: 'live', canConnect: true,
        message: external
          ? `The stream is live and its chat can be read by the connected account.${posting}`
          : 'The stream is live on your channel and its chat is available.',
      };
    }
    if (stream.status === 'upcoming') {
      return { status: 'valid', canConnect: true, message: `The stream is scheduled but not live yet. You can select it now; the scheduler starts only once it is live.${posting}` };
    }
    return { status: 'offline', canConnect: false, message: stream.status === 'ended' ? 'This livestream has ended.' : 'This video is not a livestream.' };
  }

  async function check({ url, connectionId } = {}) {
    const { videoId, url: canonical } = parseYouTubeStreamUrl(url);
    const { id, connection, provider } = resolveConnection(connectionId);
    let stream;
    try {
      const auth = await connections.getAuth(id);
      stream = await provider.getStreamByVideoId(auth, videoId, { checkChat: true });
    } catch (raw) {
      const err = toAppError(raw, id);
      activity.log({ eventType: 'stream.validated', level: 'warning', connectionId: id, provider: connection.provider, outcome: err.code, details: { videoId, code: err.code, message: err.message } });
      throw err;
    }
    const d = describe(stream);
    const owned = stream.owned !== false;
    const result = {
      videoId,
      url: canonical,
      status: d.status,
      title: stream.title ?? '',
      channelTitle: stream.channelTitle || (owned ? connection.label : '') || '',
      owned,
      external: !owned,
      chatAvailable: Boolean(stream.chatAvailable),
      chatReadable: stream.chatReadable ?? null,
      chatReason: stream.chatReason ?? null,
      postingPermission: owned ? 'owner' : 'unverified',
      requiresAcknowledgement: !owned,
      canConnect: d.canConnect,
      message: d.message,
      connectionId: id,
    };
    return { result, provider: connection.provider };
  }

  async function validate(body) {
    const { result, provider } = await check(body);
    activity.log({ eventType: 'stream.validated', level: 'info', connectionId: result.connectionId, provider, outcome: result.status, details: { videoId: result.videoId, title: result.title, external: result.external } });
    return result;
  }

  async function select({ acknowledgeExternal, ...body } = {}) {
    const locked = (id) => { if (scheduler.isLocked(id)) throw new AppError('SCHEDULER_ACTIVE', 'Stop the scheduler before changing the selected livestream.', { status: 409 }); };
    locked(fixedConnectionId ?? body.connectionId);
    const { result, provider } = await check(body);
    locked(result.connectionId);
    if (result.status === 'offline') throw new AppError('STREAM_OFFLINE', result.message, { status: 409 });
    if (!result.canConnect) throw new AppError('CHAT_UNAVAILABLE', result.message, { status: 409 });
    if (result.external && acknowledgeExternal !== true) {
      const err = new AppError('ACKNOWLEDGEMENT_REQUIRED', `This livestream is hosted by "${result.channelTitle || 'another channel'}", not the connected channel. Confirm that you have the stream owner's permission to post scheduled messages there.`, { status: 400 });
      err.hint = UNVERIFIED_POSTING;
      throw err;
    }
    const selection = scheduler.setSelection({
      videoId: result.videoId, url: result.url, title: result.title, channelTitle: result.channelTitle, connectionId: result.connectionId,
      external: result.external, acknowledgedAt: result.external ? new Date().toISOString() : null,
    });
    activity.log({ eventType: 'stream.selected', level: 'info', connectionId: result.connectionId, provider, outcome: result.status, details: { videoId: result.videoId, title: result.title, external: result.external, acknowledged: result.external } });
    return { selection, validation: result };
  }

  function clear() {
    const previous = scheduler.getSelection();
    scheduler.clearSelection();
    if (previous) activity.log({ eventType: 'stream.cleared', level: 'info', connectionId: previous.connectionId, details: { videoId: previous.videoId } });
    return get();
  }

  const get = () => ({ selection: scheduler.getSelection(), locked: scheduler.isLocked() });

  return { get, validate, select, clear };
}
