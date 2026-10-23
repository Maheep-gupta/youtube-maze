import { plain } from '../db/index.js';
import { AppError } from '../errors.js';
import { schedulerSettingsPatchSchema, schedulerSettingsSchema } from '../validation/scheduler.js';
import { createSchedulerManager, settingsError, startOfDayIso, toSession, toWorkflowSettings } from './schedulerManager.js';

export { createSchedulerEngine, createSchedulerManager } from './schedulerManager.js';

/**
 * Legacy single-scheduler API (/api/scheduler, /api/stream) over the manager: it drives the
 * "default workflow", i.e. the account in scheduler_settings.connection_id. With no default account,
 * settings are kept on scheduler_settings as the template for new workflows.
 */
export function createSchedulerService(deps) {
  const { db, connections, chatProviders, clock, defaultProvider = 'test' } = deps;
  const manager = deps.manager ?? createSchedulerManager(deps);
  const iso = (ms = clock.now()) => new Date(ms).toISOString();
  const template = () => plain(db.prepare('SELECT * FROM scheduler_settings WHERE id = 1').get());

  function defaultId() {
    const id = template().connection_id;
    if (!id) return null;
    try { connections.get(id); return id; } catch { return null; }
  }
  const setDefault = (id) => db.prepare('UPDATE scheduler_settings SET connection_id = ?, updated_at = ? WHERE id = 1').run(id, iso());

  function getSettings() {
    const id = defaultId();
    if (id) return { ...manager.engine(id).getSettings(), connectionId: id };
    return { ...toWorkflowSettings(template()), connectionId: null };
  }

  function updateSettings(patch = {}) {
    const parsedPatch = schedulerSettingsPatchSchema.safeParse(patch);
    if (!parsedPatch.success) throw settingsError(parsedPatch.error);
    const { connectionId, ...rest } = parsedPatch.data;
    const targetId = connectionId !== undefined ? connectionId : defaultId();
    if (targetId) {
      const e = manager.engine(targetId); // 404 if unknown
      e.validateSettings(rest);
      if (connectionId !== undefined) setDefault(targetId);
      e.updateSettings(rest);
      return getSettings();
    }
    const parsed = schedulerSettingsSchema.safeParse({ ...getSettings(), ...rest, connectionId: null });
    if (!parsed.success) throw settingsError(parsed.error);
    const s = parsed.data;
    db.prepare(`UPDATE scheduler_settings SET interval_seconds = ?, min_delay_seconds = ?, max_messages_per_session = ?,
      daily_limit = ?, categories = ?, max_consecutive_failures = ?, connection_id = NULL, review_mode = ?, updated_at = ? WHERE id = 1`)
      .run(s.intervalSeconds, s.minDelaySeconds, s.maxMessagesPerSession, s.dailyLimit, JSON.stringify(s.categories),
        s.maxConsecutiveFailures, s.reviewMode ? 1 : 0, iso());
    return getSettings();
  }

  const getSelection = () => { const id = defaultId(); return id ? manager.engine(id).getSelection() : null; };

  function setSelection(selection) {
    const id = selection.connectionId ?? defaultId();
    if (!id) throw new AppError('NO_CONNECTION', 'Select a sending account before choosing a livestream.', { status: 400 });
    return manager.engine(id).setSelection(selection);
  }

  const clearSelection = () => { const id = defaultId(); return id ? manager.engine(id).clearSelection() : null; };

  function isLocked(connectionId) {
    const id = connectionId ?? defaultId();
    return id ? manager.engine(id).isLocked() : false;
  }

  async function start({ connectionId } = {}) {
    const id = connectionId ?? defaultId();
    if (!id) throw new AppError('NO_CONNECTION', 'Connect an account (or add a test connection) and select it before starting.', { status: 400 });
    const status = await manager.engine(id).start();
    if (id !== template().connection_id) setDefault(id);
    return status;
  }

  function withDefault(fn, idle) {
    const id = defaultId();
    if (id) return fn(manager.engine(id));
    if (idle) return idle();
    throw new AppError('NOT_RUNNING', 'The scheduler is not running.', { status: 409 });
  }

  function idleStatus() {
    const settings = getSettings();
    const provider = chatProviders[defaultProvider];
    const session = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT 1').get();
    return {
      connectionId: null,
      state: 'idle',
      session: toSession(session),
      nextRunAt: null,
      msUntilNext: null,
      inFlight: false,
      provider: defaultProvider,
      isTestMode: provider ? Boolean(provider.isTestMode) : defaultProvider === 'test',
      settings,
      stream: null,
      pendingReview: null,
      locked: false,
      today: { sent: Number(db.prepare('SELECT COUNT(*) AS n FROM send_ledger WHERE ts >= ?').get(startOfDayIso(clock.now())).n), limit: settings.dailyLimit },
    };
  }

  return {
    manager,
    getSettings,
    updateSettings,
    getSelection,
    setSelection,
    clearSelection,
    isLocked,
    start,
    pause: () => withDefault((e) => e.pause()),
    resume: () => withDefault((e) => e.resume()),
    stop: (reason) => withDefault((e) => e.stop(reason), idleStatus),
    getStatus: () => withDefault((e) => e.getStatus(), idleStatus),
    tick: () => withDefault((e) => e.tick(), () => ({ skipped: 'not_running' })),
    approveReview: () => withDefault((e) => e.approveReview()),
    rejectReview: () => withDefault((e) => e.rejectReview()),
  };
}
