import crypto from 'node:crypto';
import { plain } from '../db/index.js';
import { AppError, ChatProviderError, isAccountError } from '../errors.js';
import { redactString } from '../logger.js';
import { workflowSettingsPatchSchema, workflowSettingsSchema } from '../validation/scheduler.js';

const FIRST_TICK_MAX_MS = 10_000;
const START_ERROR_STATUS = { NOT_LIVE: 409, CHAT_UNAVAILABLE: 409, AUTH_FAILED: 400, PERMISSION_DENIED: 403, NOT_CONFIGURED: 400, STREAM_NOT_FOUND: 404, QUOTA_EXCEEDED: 429 };
const CONCURRENT_EXTERNAL_MESSAGE = 'Concurrent workflows are allowed only when each one posts to a stream owned by its own account.';

function parseCategories(text) {
  let categories = [];
  try { categories = JSON.parse(text); } catch { categories = []; }
  return Array.isArray(categories) ? categories : [];
}

export function toWorkflowSettings(row) {
  const r = plain(row);
  return {
    intervalSeconds: r.interval_seconds,
    minDelaySeconds: r.min_delay_seconds,
    maxMessagesPerSession: r.max_messages_per_session,
    dailyLimit: r.daily_limit ?? null,
    categories: parseCategories(r.categories),
    maxConsecutiveFailures: r.max_consecutive_failures,
    reviewMode: Boolean(r.review_mode),
  };
}

/** Selected livestream stored on a workflow row, or null. */
function toSelection(row, connectionId) {
  const r = plain(row);
  if (!r?.target_video_id) return null;
  return {
    videoId: r.target_video_id,
    url: r.target_url,
    title: r.target_title ?? '',
    channelTitle: r.target_channel_title ?? '',
    connectionId,
    validatedAt: r.target_validated_at ?? null,
    external: Boolean(r.target_external),
    acknowledgedAt: r.target_acknowledged_at ?? null,
  };
}

export function toSession(row) {
  if (!row) return null;
  const r = plain(row);
  return {
    id: r.id,
    connectionId: r.connection_id ?? null,
    provider: r.provider,
    broadcastId: r.broadcast_id ?? null,
    videoId: r.video_id ?? null,
    liveChatId: r.live_chat_id ?? null,
    broadcastTitle: r.broadcast_title ?? null,
    status: r.status,
    messagesSent: r.messages_sent,
    messagesFailed: r.messages_failed,
    lastMessageId: r.last_message_id ?? null,
    stopReason: r.stop_reason ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
  };
}

/** Normalize anything thrown by a provider/connection call into a ChatProviderError. */
function asChatError(err) {
  if (err instanceof ChatProviderError || err?.name === 'ChatProviderError') return err;
  return new ChatProviderError('UNKNOWN', redactString(err?.message ?? 'Unexpected provider error'), { cause: err });
}

export function settingsError(error) {
  const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return new AppError('INVALID_SETTINGS', issues[0]?.message ?? 'Invalid scheduler settings.', { status: 400, details: issues });
}

export function startOfDayIso(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Scheduler engine for ONE account connection. One session at a time, bound to the ONE livestream
 * selected for this account (on its own channel or, after an explicit acknowledgement, another
 * channel). It only ever sends with this account's auth to that stream's chat; it never falls back
 * to another broadcast or another account. Ticks are chained with clock.setTimeout (never
 * setInterval) and guarded against overlap. In review mode each proposed message waits for
 * approveReview() before it is posted.
 *
 * `withStartLock(fn)` serializes starts across engines and `checkPolicy(connectionId, target)`
 * enforces cross-workflow rules (both provided by the manager).
 */
export function createSchedulerEngine({
  db, activity, messages, connections, chatProviders, clock, connectionId, defaultProvider = 'test',
  withStartLock = (fn) => fn(), checkPolicy = () => {}, requireTerms = () => {},
}) {
  const iso = (ms = clock.now()) => new Date(ms).toISOString();
  const log = (entry) => activity.log({ connectionId, ...entry });

  /** In-memory runtime state for the active session. */
  let state = 'idle'; // idle | running | paused
  let starting = false;
  let inFlight = false;
  let timer = null;
  let nextRunAt = null;
  let run = null; // { sessionId, providerName, videoId, liveChatId, broadcastId, external, lastSuccessAt, lastMessageId, consecutiveFailures, pendingReview, lastRejectedId }

  const row = () => db.prepare('SELECT * FROM workflows WHERE connection_id = ?').get(connectionId);

  // ---- settings ---------------------------------------------------------------------------
  function getSettings() {
    const r = row();
    if (!r) throw new AppError('NOT_FOUND', 'Workflow not found', { status: 404 });
    return toWorkflowSettings(r);
  }

  /** Merge and validate a settings patch without writing it. */
  function validateSettings(patch = {}) {
    const parsedPatch = workflowSettingsPatchSchema.safeParse(patch);
    if (!parsedPatch.success) throw settingsError(parsedPatch.error);
    const parsed = workflowSettingsSchema.safeParse({ ...getSettings(), ...parsedPatch.data });
    if (!parsed.success) throw settingsError(parsed.error);
    return parsed.data;
  }

  function updateSettings(patch = {}) {
    const s = validateSettings(patch);
    db.prepare(`UPDATE workflows SET interval_seconds = ?, min_delay_seconds = ?, max_messages_per_session = ?,
      daily_limit = ?, categories = ?, max_consecutive_failures = ?, review_mode = ?, updated_at = ? WHERE connection_id = ?`)
      .run(s.intervalSeconds, s.minDelaySeconds, s.maxMessagesPerSession, s.dailyLimit, JSON.stringify(s.categories),
        s.maxConsecutiveFailures, s.reviewMode ? 1 : 0, iso(), connectionId);
    return getSettings();
  }

  // ---- stream selection -------------------------------------------------------------------
  const getSelection = () => toSelection(row(), connectionId);
  const isLocked = () => state !== 'idle' || starting;

  function assertUnlocked() {
    if (isLocked()) throw new AppError('SCHEDULER_ACTIVE', 'Stop the scheduler before changing the selected livestream.', { status: 409 });
  }

  /** Persist the selected stream (already validated by the caller with THIS account). Refused while active. */
  function setSelection({ videoId, url, title = '', channelTitle = '', external = false, acknowledgedAt = null }) {
    assertUnlocked();
    db.prepare(`UPDATE workflows SET target_video_id = ?, target_url = ?, target_title = ?, target_channel_title = ?,
      target_validated_at = ?, target_external = ?, target_acknowledged_at = ?, updated_at = ? WHERE connection_id = ?`)
      .run(videoId, url, String(title).slice(0, 300), String(channelTitle).slice(0, 300), iso(),
        external ? 1 : 0, external ? acknowledgedAt : null, iso(), connectionId);
    return getSelection();
  }

  function clearSelection() {
    assertUnlocked();
    db.prepare(`UPDATE workflows SET target_video_id = NULL, target_url = NULL, target_title = NULL, target_channel_title = NULL,
      target_validated_at = NULL, target_external = 0, target_acknowledged_at = NULL, updated_at = ? WHERE connection_id = ?`)
      .run(iso(), connectionId);
    return null;
  }

  // ---- helpers ----------------------------------------------------------------------------
  const getSessionRow = (id) => toSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
  const latestSession = () => toSession(db.prepare('SELECT * FROM sessions WHERE connection_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(connectionId));

  // Counted per account from the append-only send_ledger, so clearing activity logs cannot reset it.
  const sentToday = () => Number(db.prepare('SELECT COUNT(*) AS n FROM send_ledger WHERE connection_id = ? AND ts >= ?')
    .get(connectionId, startOfDayIso(clock.now())).n);

  function clearTimer() {
    if (timer != null) clock.clearTimeout(timer);
    timer = null;
    nextRunAt = null;
  }

  function scheduleIn(ms) {
    clearTimer();
    const delay = Math.max(0, Math.round(ms));
    nextRunAt = clock.now() + delay;
    timer = clock.setTimeout(onTimer, delay);
  }

  async function onTimer() {
    timer = null;
    nextRunAt = null;
    let result;
    try {
      result = await tick();
    } catch (err) {
      // Unexpected (non-provider) failure, e.g. a database error. Never leave an unhandled rejection.
      log({ eventType: 'scheduler.error', level: 'error', sessionId: run?.sessionId, details: { error: err } });
      finalize('error', `Unexpected scheduler error: ${redactString(err?.message ?? 'unknown')}`);
      return;
    }
    if (state === 'running' && timer == null) {
      scheduleIn(result?.nextDelayMs ?? getSettings().intervalSeconds * 1000);
    }
  }

  /** Clear timer, reset runtime state, and persist the final session status. Idempotent. */
  function finalize(status, reason, { level = 'info' } = {}) {
    clearTimer();
    if (state === 'idle' || !run) { state = 'idle'; run = null; return; }
    const { sessionId, providerName } = run;
    state = 'idle';
    run = null;
    db.prepare('UPDATE sessions SET status = ?, stop_reason = ?, ended_at = ? WHERE id = ?').run(status, reason, iso(), sessionId);
    log({ eventType: 'scheduler.stop', level, sessionId, provider: providerName, outcome: status, details: { reason } });
  }

  function providerFor(name) {
    const provider = chatProviders[name];
    if (!provider) throw new AppError('PROVIDER_UNAVAILABLE', `Chat provider "${name}" is not available.`, { status: 400 });
    return provider;
  }

  function resolveProviderName() {
    if (run) return run.providerName;
    try { return connections.get(connectionId).provider; } catch { return defaultProvider; }
  }

  // ---- lifecycle --------------------------------------------------------------------------
  async function start() {
    if (state !== 'idle' || starting) throw new AppError('ALREADY_RUNNING', 'The scheduler is already running. Stop it first.', { status: 409 });
    starting = true;
    try {
      return await withStartLock(doStart);
    } finally {
      starting = false;
    }
  }

  async function doStart() {
    const settings = getSettings();
    const connection = connections.get(connectionId);
    const provider = providerFor(connection.provider);
    const selection = getSelection();
    if (!selection) throw new AppError('NO_STREAM_SELECTED', 'Select a livestream in Livestream Setup before starting.', { status: 400 });
    // Fail fast on the stored flags; re-checked below with the live ownership result.
    checkPolicy(connectionId, { videoId: selection.videoId, external: selection.external });
    // External Livestream Terms: an extra gate, never a substitute for the checks below.
    if (selection.external) requireTerms(connectionId, selection.videoId);

    let broadcast;
    try {
      const auth = await connections.getAuth(connectionId);
      const stream = await provider.getStreamByVideoId(auth, selection.videoId, { checkChat: true });
      const name = stream.title || selection.title || selection.videoId;
      if (stream.status !== 'live') throw new ChatProviderError('NOT_LIVE', `The selected livestream "${name}" is not live (${stream.status}).`);
      if (!stream.chatAvailable || !stream.liveChatId) {
        throw new ChatProviderError('CHAT_UNAVAILABLE', `Live chat is unavailable for "${name}"${stream.chatReason ? `: ${stream.chatReason}` : '.'}`);
      }
      broadcast = stream;
    } catch (raw) {
      if (raw instanceof AppError) throw raw;
      const err = asChatError(raw);
      if (isAccountError(err)) connections.markError(connectionId, err);
      log({ eventType: 'scheduler.error', level: 'error', provider: connection.provider, outcome: err.code, details: { phase: 'start', code: err.code, message: err.message } });
      const appErr = new AppError(err.code, err.message, { status: START_ERROR_STATUS[err.code] ?? 502 });
      appErr.hint = err.hint;
      throw appErr;
    }
    const external = broadcast.owned === false;
    checkPolicy(connectionId, { videoId: selection.videoId, external });
    if (external) requireTerms(connectionId, selection.videoId);

    if (settings.dailyLimit != null && sentToday() >= settings.dailyLimit) {
      throw new AppError('DAILY_LIMIT_REACHED', `The daily limit of ${settings.dailyLimit} messages has already been reached.`, { status: 409 });
    }
    const eligible = typeof messages.countEligible === 'function'
      ? messages.countEligible({ categories: settings.categories })
      : (messages.pickRandom({ categories: settings.categories }) ? 1 : 0);
    if (!eligible) throw new AppError('NO_MESSAGES', 'There are no enabled messages in the selected categories.', { status: 400 });

    const sessionId = crypto.randomUUID();
    db.prepare(`INSERT INTO sessions (id, connection_id, provider, broadcast_id, video_id, live_chat_id, broadcast_title, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
      .run(sessionId, connectionId, connection.provider, broadcast.broadcastId ?? null, broadcast.videoId, broadcast.liveChatId, broadcast.title ?? null, iso());

    run = {
      sessionId,
      providerName: connection.provider,
      videoId: broadcast.videoId,
      liveChatId: broadcast.liveChatId,
      broadcastId: broadcast.broadcastId ?? null,
      external,
      lastSuccessAt: null,
      lastMessageId: null,
      consecutiveFailures: 0,
      pendingReview: null,
      lastRejectedId: null,
    };
    state = 'running';
    log({
      eventType: 'scheduler.start', level: 'info', sessionId, provider: connection.provider,
      details: {
        broadcastTitle: broadcast.title, videoId: broadcast.videoId, external,
        intervalSeconds: settings.intervalSeconds, categories: settings.categories, reviewMode: settings.reviewMode,
      },
    });
    scheduleIn(Math.min(FIRST_TICK_MAX_MS, settings.intervalSeconds * 1000));
    return getStatus();
  }

  function pause() {
    if (state === 'idle') throw new AppError('NOT_RUNNING', 'The scheduler is not running.', { status: 409 });
    if (state === 'paused') return getStatus();
    clearTimer();
    state = 'paused';
    db.prepare("UPDATE sessions SET status = 'paused' WHERE id = ?").run(run.sessionId);
    log({ eventType: 'scheduler.pause', level: 'info', sessionId: run.sessionId, provider: run.providerName });
    return getStatus();
  }

  function resume() {
    if (state === 'idle') throw new AppError('NOT_RUNNING', 'The scheduler is not running.', { status: 409 });
    if (state === 'running') return getStatus();
    if (run.external) requireTerms(connectionId, run.videoId); // a decline while paused withdraws acceptance
    state = 'running';
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(run.sessionId);
    log({ eventType: 'scheduler.resume', level: 'info', sessionId: run.sessionId, provider: run.providerName });
    const { minDelaySeconds } = getSettings();
    const earliest = run.lastSuccessAt == null ? clock.now() : run.lastSuccessAt + minDelaySeconds * 1000;
    // If a tick is still in flight, onTimer/tick completion will not reschedule (no timer was running),
    // so always schedule here; the overlap guard protects against a double send.
    scheduleIn(Math.max(0, earliest - clock.now()));
    return getStatus();
  }

  function stop(reason = 'Stopped by user') {
    if (state === 'idle') { clearTimer(); return getStatus(); }
    finalize('stopped', String(reason).slice(0, 300));
    return getStatus();
  }

  /** Stop with an error status (e.g. the account lost its authorization). Idempotent. */
  function halt(reason) {
    if (state !== 'idle') finalize('error', String(reason).slice(0, 300), { level: 'error' });
  }

  // ---- tick -------------------------------------------------------------------------------
  async function tick() {
    if (inFlight) {
      log({ eventType: 'scheduler.tick_skipped', level: 'warning', sessionId: run?.sessionId, details: { reason: 'A send is already in progress.' } });
      return { skipped: 'overlap' };
    }
    if (state !== 'running' || !run) return { skipped: 'not_running' };
    inFlight = true;
    try {
      return await runTick(run);
    } finally {
      inFlight = false;
    }
  }

  function limitReached(current, settings, sessionRow) {
    if (sessionRow.messagesSent >= settings.maxMessagesPerSession) {
      log({ eventType: 'scheduler.limit_reached', level: 'info', sessionId: current.sessionId, details: { limit: 'session', value: settings.maxMessagesPerSession } });
      finalize('completed', `Session limit of ${settings.maxMessagesPerSession} messages reached.`);
      return { stopped: 'session_limit' };
    }
    if (settings.dailyLimit != null && sentToday() >= settings.dailyLimit) {
      log({ eventType: 'scheduler.limit_reached', level: 'info', sessionId: current.sessionId, details: { limit: 'daily', value: settings.dailyLimit } });
      finalize('completed', `Daily limit of ${settings.dailyLimit} messages reached.`);
      return { stopped: 'daily_limit' };
    }
    return null;
  }

  /** Record a failed attempt; stops on fatal errors or too many consecutive failures. */
  function recordFailure(current, settings, rawErr, { messageId, category, countAsMessage = true } = {}) {
    const err = asChatError(rawErr);
    const { sessionId, providerName } = current;
    if (countAsMessage) {
      db.prepare('UPDATE sessions SET messages_failed = messages_failed + 1 WHERE id = ?').run(sessionId);
    }
    log({
      eventType: countAsMessage ? 'message.failed' : 'scheduler.error',
      level: 'error', sessionId, provider: providerName, category, messageId, outcome: err.code,
      details: { code: err.code, message: err.message, hint: err.hint, fatal: err.fatal },
    });
    let result = { failed: err.code };
    if (current === run) {
      current.consecutiveFailures++;
      if (err.fatal) {
        finalize('error', `${err.code}: ${err.message}`, { level: 'error' });
        result = { failed: err.code, stopped: 'fatal' };
      } else if (current.consecutiveFailures >= settings.maxConsecutiveFailures) {
        finalize('error', `Stopped after ${current.consecutiveFailures} consecutive failures (last: ${err.code}).`, { level: 'error' });
        result = { failed: err.code, stopped: 'consecutive_failures' };
      }
    }
    // Flag the account only after this session has been finalized with its own reason.
    if (isAccountError(err)) {
      try { connections.markError(connectionId, err); } catch { /* connection may be gone */ }
    }
    return result;
  }

  /**
   * Re-check that the SELECTED stream (same video id) is still live with the same chat. Never switch.
   * Returns null when it is fine, else the tick result (session stopped or failure recorded).
   */
  async function verifyStream(current, settings, provider) {
    const { sessionId, providerName } = current;
    try {
      const auth = await connections.getAuth(connectionId);
      const stream = await provider.getStreamByVideoId(auth, current.videoId);
      if (current !== run || state === 'idle') return { skipped: 'stopped' };
      if (!stream || stream.videoId !== current.videoId || stream.status !== 'live' || stream.liveChatId !== current.liveChatId) {
        log({ eventType: 'scheduler.error', level: 'warning', sessionId, provider: providerName, outcome: 'NOT_LIVE', details: { reason: 'The selected livestream ended or its chat changed.', videoId: current.videoId } });
        finalize('error', 'NOT_LIVE: The selected livestream has ended or is no longer active.', { level: 'warning' });
        return { stopped: 'not_live' };
      }
      if (!stream.chatAvailable) {
        log({ eventType: 'scheduler.error', level: 'warning', sessionId, provider: providerName, outcome: 'CHAT_UNAVAILABLE', details: { reason: stream.chatReason ?? 'Chat unavailable.', videoId: current.videoId } });
        finalize('error', `CHAT_UNAVAILABLE: ${stream.chatReason ?? 'Live chat is no longer available for the selected stream.'}`, { level: 'warning' });
        return { stopped: 'chat_unavailable' };
      }
      return null;
    } catch (err) {
      return recordFailure(current, settings, err, { countAsMessage: false });
    }
  }

  /** Milliseconds still to wait for the minimum delay since the last successful send (0 = ok). */
  function minDelayWait(current, settings) {
    if (current.lastSuccessAt == null) return 0;
    return Math.max(0, current.lastSuccessAt + settings.minDelaySeconds * 1000 - clock.now());
  }

  /** Random enabled message, never the last one sent, and (if possible) not the one just rejected. */
  function pickMessage(current, settings) {
    const base = { categories: settings.categories, excludeId: current.lastMessageId };
    if (current.lastRejectedId != null) {
      const fresh = messages.pickRandom({ ...base, excludeIds: [current.lastRejectedId] });
      if (fresh) return fresh;
    }
    return messages.pickRandom(base);
  }

  function noMessages(current) {
    log({ eventType: 'scheduler.error', level: 'warning', sessionId: current.sessionId, provider: current.providerName, details: { reason: 'No eligible messages (need at least one enabled message other than the last one sent).' } });
    finalize('stopped', 'No eligible messages to send.', { level: 'warning' });
    return { stopped: 'no_messages' };
  }

  /** Validate and post one message to the selected chat; counts it only after the provider confirms. */
  async function sendOne(current, settings, provider, message) {
    const { sessionId, providerName } = current;
    const meta = { messageId: message.id, category: message.category };

    const checked = provider.validateMessage(message.text);
    if (!checked?.ok) {
      return recordFailure(current, settings, new ChatProviderError('INVALID_MESSAGE', checked?.reason ?? 'Message rejected by provider validation.'), meta);
    }

    let result;
    try {
      // Always this engine's own account and the chat of its own selected stream.
      const auth = await connections.getAuth(connectionId);
      result = await provider.sendMessage(auth, { liveChatId: current.liveChatId, text: checked.text });
    } catch (err) {
      return recordFailure(current, settings, err, meta);
    }
    const providerMessageId = result?.providerMessageId;
    if (typeof providerMessageId !== 'string' || !providerMessageId) {
      return recordFailure(current, settings, new ChatProviderError('UNKNOWN', 'The provider did not confirm the message (no message id returned).'), meta);
    }

    // Confirmed by the provider: record the send even if the session was stopped meanwhile.
    const sentAt = clock.now();
    messages.markSent(message.id, iso(sentAt));
    try { connections.markUsed(connectionId); } catch { /* non-critical */ }
    db.prepare('UPDATE sessions SET messages_sent = messages_sent + 1, last_message_id = ? WHERE id = ?').run(message.id, sessionId);
    db.prepare('INSERT INTO send_ledger (ts, session_id, provider, provider_message_id, message_id, connection_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(iso(sentAt), sessionId, providerName, providerMessageId, message.id, connectionId);
    current.lastSuccessAt = sentAt;
    current.lastMessageId = message.id;
    current.lastRejectedId = null;
    current.consecutiveFailures = 0;
    log({
      eventType: 'message.sent', level: 'success', sessionId, provider: providerName, ...meta, outcome: 'sent',
      details: { providerMessageId, text: checked.text, publishedAt: result.publishedAt ?? null, videoId: current.videoId },
    });

    if (current === run) {
      const limitedAfter = limitReached(current, settings, getSessionRow(sessionId));
      if (limitedAfter) return { sent: true, providerMessageId, ...limitedAfter };
    }
    return { sent: true, providerMessageId, messageId: message.id };
  }

  async function runTick(current) {
    const settings = getSettings();
    const { sessionId, providerName } = current;

    const limited = limitReached(current, settings, getSessionRow(sessionId));
    if (limited) return limited;

    const provider = chatProviders[providerName];
    if (!provider) return recordFailure(current, settings, new ChatProviderError('NOT_CONFIGURED', `Chat provider "${providerName}" is not available.`), { countAsMessage: false });

    const streamProblem = await verifyStream(current, settings, provider);
    if (streamProblem) return streamProblem;
    if (current !== run || state !== 'running') return { skipped: 'stopped' };

    // A proposal is waiting for the user: only liveness is re-checked until they decide.
    if (current.pendingReview) return { skipped: 'awaiting_review' };

    const wait = minDelayWait(current, settings);
    if (wait > 0) {
      log({ eventType: 'scheduler.tick_skipped', level: 'info', sessionId, details: { reason: 'Minimum delay since last message not reached.', waitMs: wait } });
      return { skipped: 'min_delay', nextDelayMs: wait };
    }

    const message = pickMessage(current, settings);
    if (!message) return noMessages(current);

    if (settings.reviewMode) {
      current.pendingReview = { messageId: message.id, text: message.text, category: message.category, proposedAt: iso() };
      log({ eventType: 'scheduler.review_pending', level: 'info', sessionId, provider: providerName, messageId: message.id, category: message.category, details: { text: message.text, videoId: current.videoId } });
      return { proposed: true, messageId: message.id };
    }
    return sendOne(current, settings, provider, message);
  }

  // ---- manual review ----------------------------------------------------------------------
  function assertPending() {
    if (state === 'idle' || !run) throw new AppError('NOT_RUNNING', 'The scheduler is not running.', { status: 409 });
    if (!run.pendingReview) throw new AppError('NO_PENDING_REVIEW', 'There is no proposed message waiting for review.', { status: 409 });
  }

  /**
   * Post the proposed message now (review mode). Re-checks the selected stream first, honours the
   * minimum delay and the overlap guard, and counts the message only after the provider confirms it.
   */
  async function approveReview() {
    assertPending();
    if (state === 'paused') throw new AppError('PAUSED', 'Resume the scheduler before approving the proposed message.', { status: 409 });
    if (inFlight) throw new AppError('SEND_IN_PROGRESS', 'A send is already in progress. Try again in a moment.', { status: 409 });
    const current = run;
    const settings = getSettings();
    const wait = minDelayWait(current, settings);
    if (wait > 0) {
      throw new AppError('TOO_SOON', `The minimum delay since the last message has not passed yet (${Math.ceil(wait / 1000)} s left).`, { status: 409, details: { waitMs: wait } });
    }
    const provider = chatProviders[current.providerName];
    if (!provider) throw new AppError('PROVIDER_UNAVAILABLE', `Chat provider "${current.providerName}" is not available.`, { status: 400 });

    const pending = current.pendingReview;
    log({ eventType: 'scheduler.review_approved', level: 'info', sessionId: current.sessionId, provider: current.providerName, messageId: pending.messageId, category: pending.category });
    inFlight = true;
    let result;
    try {
      const problem = await verifyStream(current, settings, provider);
      if (problem) {
        const code = problem.failed ?? (problem.stopped === 'chat_unavailable' ? 'CHAT_UNAVAILABLE' : 'NOT_LIVE');
        result = { failed: code, message: 'The selected livestream is no longer available; nothing was posted.' };
      } else {
        current.pendingReview = null;
        const sent = await sendOne(current, settings, provider, { id: pending.messageId, text: pending.text, category: pending.category });
        result = sent.sent
          ? { sent: true, providerMessageId: sent.providerMessageId }
          : { failed: sent.failed, message: 'YouTube did not accept the message; it was not counted as sent.' };
      }
    } finally {
      inFlight = false;
    }
    if (current === run && state === 'running' && timer == null) scheduleIn(settings.intervalSeconds * 1000);
    return { result, status: getStatus() };
  }

  /** Discard the proposed message; the next tick proposes a different one when possible. */
  function rejectReview() {
    assertPending();
    const pending = run.pendingReview;
    run.pendingReview = null;
    run.lastRejectedId = pending.messageId;
    log({ eventType: 'scheduler.review_rejected', level: 'info', sessionId: run.sessionId, provider: run.providerName, messageId: pending.messageId, category: pending.category });
    return getStatus();
  }

  // ---- status -----------------------------------------------------------------------------
  function getStatus() {
    const settings = getSettings();
    const providerName = resolveProviderName();
    const provider = chatProviders[providerName];
    const now = clock.now();
    return {
      connectionId,
      state,
      session: run ? getSessionRow(run.sessionId) : latestSession(),
      nextRunAt: nextRunAt == null ? null : iso(nextRunAt),
      msUntilNext: nextRunAt == null ? null : Math.max(0, nextRunAt - now),
      inFlight,
      provider: providerName,
      isTestMode: provider ? Boolean(provider.isTestMode) : providerName === 'test',
      settings: { ...settings, connectionId },
      stream: getSelection(),
      pendingReview: run?.pendingReview ? { ...run.pendingReview } : null,
      locked: isLocked(),
      today: { sent: sentToday(), limit: settings.dailyLimit },
    };
  }

  /** What this engine is doing right now, for the manager's cross-workflow checks. */
  const activeTarget = () => (state === 'idle' || !run ? null : { videoId: run.videoId, external: run.external });

  return {
    connectionId,
    getSettings, validateSettings, updateSettings, getSelection, setSelection, clearSelection, isLocked,
    start, pause, resume, stop, halt, getStatus, tick, approveReview, rejectReview, activeTarget,
    getState: () => state,
  };
}

/**
 * One scheduler engine per account connection (created lazily, each with its own workflows row).
 * Starts are serialized so the cross-workflow rules below cannot be raced:
 *   - two active workflows never target the same stream (STREAM_IN_USE);
 *   - a workflow targeting a stream NOT owned by its account never runs alongside any other
 *     workflow, in either direction (CONCURRENT_EXTERNAL_BLOCKED). Concurrent workflows are only for
 *     administering several channels, each posting to a stream it owns.
 * Account events from the connections service stop that account's engine only.
 */
export function createSchedulerManager({ db, activity, messages, connections, chatProviders, clock, defaultProvider = 'test', terms = null }) {
  const requireTerms = terms ? (connectionId, videoId) => terms.requireAccepted({ connectionId, videoId }) : undefined;
  const iso = (ms = clock.now()) => new Date(ms).toISOString();
  const engines = new Map();
  let lock = Promise.resolve();

  // ---- restart recovery (all accounts) ----------------------------------------------------
  {
    const stale = db.prepare("SELECT id, connection_id FROM sessions WHERE status IN ('running', 'paused')").all();
    if (stale.length) {
      db.prepare("UPDATE sessions SET status = 'stopped', stop_reason = 'Application restarted', ended_at = ? WHERE status IN ('running', 'paused')")
        .run(iso());
      for (const { id, connection_id: connectionId } of stale) {
        activity.log({ eventType: 'scheduler.stop', level: 'warning', sessionId: id, connectionId, outcome: 'stopped', details: { reason: 'Application restarted' } });
      }
    }
  }

  function withStartLock(fn) {
    const next = lock.then(fn, fn);
    lock = next.catch(() => {});
    return next;
  }

  function checkPolicy(connectionId, { videoId, external }) {
    const others = [...engines.values()].filter((e) => e.connectionId !== connectionId).map((e) => e.activeTarget()).filter(Boolean);
    if (others.some((t) => t.videoId === videoId)) {
      throw new AppError('STREAM_IN_USE', 'Another account\'s workflow is already running for this livestream. Stop it first.', { status: 409 });
    }
    if (others.length && (external || others.some((t) => t.external))) {
      throw new AppError('CONCURRENT_EXTERNAL_BLOCKED', CONCURRENT_EXTERNAL_MESSAGE, { status: 409 });
    }
  }

  /** Create the account's workflow row (settings copied from the legacy template) if missing. */
  function ensureWorkflow(connectionId) {
    connections.get(connectionId); // 404 if unknown
    db.prepare(`INSERT OR IGNORE INTO workflows (connection_id, interval_seconds, min_delay_seconds, max_messages_per_session,
      daily_limit, categories, max_consecutive_failures, review_mode, created_at, updated_at)
      SELECT ?, interval_seconds, min_delay_seconds, max_messages_per_session, daily_limit, categories, max_consecutive_failures,
        review_mode, ?, ? FROM scheduler_settings WHERE id = 1`).run(connectionId, iso(), iso());
  }

  function engine(connectionId) {
    const id = String(connectionId);
    let e = engines.get(id);
    if (e) return e;
    ensureWorkflow(id);
    e = createSchedulerEngine({
      db, activity, messages, connections, chatProviders, clock, connectionId: id, defaultProvider, withStartLock, checkPolicy, requireTerms,
    });
    engines.set(id, e);
    return e;
  }

  const peek = (connectionId) => engines.get(String(connectionId)) ?? null;

  function stopFor(connectionId, reason) {
    peek(connectionId)?.stop(reason);
  }

  function removeWorkflow(connectionId) {
    const id = String(connectionId);
    peek(id)?.stop('Account removed');
    engines.delete(id);
    db.prepare('DELETE FROM workflows WHERE connection_id = ?').run(id);
  }

  function stopAll(reason) {
    for (const e of engines.values()) e.stop(reason);
  }

  function deleteAll() {
    stopAll('Data cleanup');
    engines.clear();
    db.prepare('DELETE FROM workflows').run();
  }

  /** Engines for every existing connection (in connection order). */
  function list() {
    return connections.list().map((c) => ({ connection: c, engine: engine(c.id) }));
  }

  connections.onAccountEvent?.((event, connectionId, err) => {
    if (event === 'disconnected') stopFor(connectionId, 'Account disconnected');
    else if (event === 'removed') removeWorkflow(connectionId);
    else if (event === 'auth_error') peek(connectionId)?.halt(`${err?.code ?? 'AUTH_FAILED'}: Account authorization failed. Reconnect the account.`);
  });
  connections.useWorkflowState?.((connectionId) => peek(connectionId)?.getState() ?? 'idle');

  return { engine, peek, list, stopFor, stopAll, removeWorkflow, deleteAll, checkPolicy };
}
