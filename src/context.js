import { openDatabase } from './db/index.js';
import { createCipher, loadEncryptionKey } from './security/crypto.js';
import { registerSecret } from './logger.js';
import { assertChatProvider } from './providers/chat/ChatProvider.js';
import { assertAiProvider } from './providers/ai/AiProvider.js';
import { createYouTubeProvider } from './providers/chat/youtubeProvider.js';
import { createTestChatProvider } from './providers/chat/testProvider.js';
import { createOpenAiCompatibleProvider } from './providers/ai/openaiCompatible.js';
import { createPresetProvider } from './providers/ai/presetProvider.js';
import { createActivityService } from './services/activity.js';
import { createMessagesService } from './services/messages.js';
import { createConnectionsService } from './services/connections.js';
import { createGoogleOAuth } from './services/googleOAuth.js';
import { createDraftsService } from './services/drafts.js';
import { createSchedulerService } from './services/scheduler.js';
import { createSchedulerManager } from './services/schedulerManager.js';
import { createStreamSelectionService } from './services/streamSelection.js';
import { createTermsService } from './services/terms.js';

/**
 * Composition root. Everything is injectable so tests can pass mocks:
 *   createContext({ config, db, chatProviders: { youtube, test }, aiProvider, fetch, clock })
 */
export function createContext(config, overrides = {}) {
  const db = overrides.db ?? openDatabase(config.dbPath);
  const cipher = overrides.cipher ?? createCipher(loadEncryptionKey(config));
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const clock = overrides.clock ?? { now: () => Date.now(), setTimeout, clearTimeout };

  registerSecret(config.google.clientSecret);
  registerSecret(config.ai.apiKey);
  registerSecret(config.tokenEncryptionKey);

  const chatProviders = overrides.chatProviders ?? {
    youtube: createYouTubeProvider({ fetch: fetchImpl }),
    test: createTestChatProvider(),
  };
  Object.values(chatProviders).forEach(assertChatProvider);

  const presetProvider = overrides.presetProvider ?? createPresetProvider();
  const aiProvider = assertAiProvider(overrides.aiProvider ?? createOpenAiCompatibleProvider({ ...config.ai, fetch: fetchImpl }));

  const activity = createActivityService({ db, clock });
  const messages = createMessagesService({ db, activity, clock });
  const googleOAuth = overrides.googleOAuth ?? createGoogleOAuth({ config, fetch: fetchImpl, clock });
  const connections = createConnectionsService({ db, cipher, activity, googleOAuth, chatProviders, clock });
  const drafts = createDraftsService({ db, activity, messages, aiProvider, presetProvider });
  // One scheduler engine per account (schedulers); `scheduler` is the legacy single-scheduler API
  // over the default account's workflow.
  const schedulerDeps = { db, activity, messages, connections, chatProviders, clock, defaultProvider: config.chatProvider };
  const terms = createTermsService({ db, connections, activity, clock });
  const schedulers = createSchedulerManager({ ...schedulerDeps, terms });
  const scheduler = createSchedulerService({ ...schedulerDeps, manager: schedulers });

  const streamSelection = createStreamSelectionService({ scheduler, connections, chatProviders, activity });

  return { config, db, cipher, clock, chatProviders, aiProvider, presetProvider, activity, messages, googleOAuth, connections, drafts, schedulers, scheduler, streamSelection, terms };
}
