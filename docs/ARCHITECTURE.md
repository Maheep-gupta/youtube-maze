# Architecture & Module Contracts

This is the source of truth for module boundaries. If code and this document disagree, fix one of them.

## Principles

- **One workflow per authorized account, each bound to its own selected stream, real YouTube permissions.** Several accounts may be connected (legitimate administration of several channels). Each connection has its own OAuth grant, encrypted tokens, workflow (settings, review mode, stream selection, session) and audit trail. A workflow posts only as its own account to the livestream selected for it — that channel's own stream or another channel's. Ownership is reported (`owned`), not required; knowing a URL never implies posting permission: for external streams posting permission is `unverified` until YouTube accepts a message, and permission failures are never converted into success. Selecting an external stream requires a server-enforced acknowledgement of the owner's permission (`ACKNOWLEDGEMENT_REQUIRED`). A workflow never falls back to, or switches to, another broadcast or another account.
- **No coordinated multi-account posting.** Cross-workflow rules are enforced on the server at start/resume, under a lock: concurrent workflows only when each active one posts to a stream owned by its own account; a stream is bound to at most one active workflow (`STREAM_IN_USE`); a workflow on an external stream must be the only active workflow (`CONCURRENT_EXTERNAL_BLOCKED`). No account rotation, no automatic account switching, no bypassing chat restrictions.
- **Supported APIs only.** Posting uses YouTube Data API v3 `liveChatMessages.insert`. No browser automation of YouTube, no private endpoints, no anti-detection. Playwright is used only to test our own dashboard.
- **Never fake success.** A message is "sent" only when the provider returns a message id.
- **Secrets stay server-side.** Tokens are AES-256-GCM encrypted in SQLite (`src/security/crypto.js`). Every log/activity/export path runs through `redact()` (`src/logger.js`). No secret is ever returned by any API route.
- **Dependency injection.** `src/context.js` is the composition root; tests pass mocks (`test/helpers.js`).

## Layout

```
src/
  server.js                 entry; binds 127.0.0.1
  app.js                    express app, guards, error handler          [foundation]
  context.js                composition root                             [foundation]
  config.js errors.js logger.js                                          [foundation]
  db/index.js db/migrations/*.sql                                        [foundation]
  security/crypto.js origin.js rateLimit.js                              [foundation]
  lib/text.js  lib/http.js                                               [foundation]
  providers/chat/ChatProvider.js   (contract)                            [foundation]
  providers/chat/youtubeProvider.js testProvider.js                      [YouTube agent]
  providers/ai/AiProvider.js       (contract)                            [foundation]
  providers/ai/openaiCompatible.js presetProvider.js presetLibrary.js    [AI agent]
  services/googleOAuth.js connections.js                                 [YouTube agent]
  services/drafts.js                                                     [AI agent]
  services/activity.js messages.js scheduler.js                          [Core agent]
  services/schedulerManager.js  (per-account engines, cross-workflow rules) [Core agent]
  services/streamSelection.js  lib/youtubeUrl.js                         [Core agent]
  routes/connections.js oauth.js                                         [YouTube agent]
  routes/drafts.js                                                       [AI agent]
  routes/system.js messages.js scheduler.js logs.js stream.js workflows.js [Core agent]
  validation/<area>.js       zod schemas, one file per owner area
public/index.html css/app.css js/*.js                                    [Frontend agent]
samples/messages.sample.json                                             [AI agent]
scripts/import-messages.js backup.js restore.js                          [Docs/QA agent]
test/unit/<area>.test.js   each owner tests its own modules
test/integration/*.test.js test/e2e/*.spec.js                            [Docs/QA agent]
```

## Conventions

- ES modules, Node >= 22.13, `node:sqlite` (`DatabaseSync`, synchronous). Use `plain(row)` from `db/index.js` before returning rows; map snake_case DB columns to camelCase in service return values.
- Timestamps: ISO strings from `new Date(clock.now()).toISOString()` (services that take `clock`) or `nowIso()`.
- Service errors: throw `AppError(code, message, { status })`. Chat provider errors: `ChatProviderError(code, message)`. AI: `AiProviderError`.
- Routes: `export default function xRouter(ctx, { strictLimiter, csrfToken }) { const r = express.Router(); ...; return r; }`. Wrap async handlers in `ah()` from `lib/http.js`, validate bodies/query/params with zod (`parse(schema, req.body)`); ZodError is mapped to 400 centrally. Use `.strict()` on body schemas.
- Successful responses: plain JSON objects (no envelope). Errors: `{ error: { code, message, hint?, details? } }` (central handler).
- Tests: `node:test` + `node:assert/strict`; `supertest` for HTTP. Never hit the network. Use `test/helpers.js` (`testDb`, `testCipher`, `createFakeClock`, `createMockChatProvider`, `createMockAiProvider`, `createMockFetch`).
- Message text: always use `sanitizeText`, `normalizeForCompare`, `validateMessageText` from `lib/text.js`. Max 200 visible chars (YouTube limit).
- Categories: `CATEGORIES` in `config.js`: `compliments, sarcasm, witty_jokes, motivation, wholesome`.

## Chat provider contract (`providers/chat/ChatProvider.js`)

Methods: `getAuthorizedChannel`, `getActiveBroadcast` (used only by Accounts → Check stream), `getStreamByVideoId`, `checkChat`, `validateMessage`, `sendMessage`. All failures throw `ChatProviderError`. Providers are pluggable via `context.chatProviders[name]`; the scheduler depends only on this contract, so a future provider lives in its own module under `providers/chat/` and never inside the scheduler.

`providers/chat/youtubeProvider.js` **is** the pluggable YouTube chat provider (official Data API v3 only). The operations sometimes named `validateStream(videoId)` / `getChatStatus(videoId)` / `sendMessage(videoId, message)` / `getLastError()` map onto it as follows:

| Operation | Implemented as |
|---|---|
| validateStream / getChatStatus | `getStreamByVideoId(auth, videoId, { checkChat })` — `checkChat: true` at validate/select/start, `false` per tick |
| sendMessage(videoId, text) | `sendMessage(auth, { liveChatId, text })`, where the scheduler resolves `liveChatId` from the selected video by `getStreamByVideoId` right before each send |
| getLastError | scheduler status (`session.stopReason`), `connections.lastError` for auth failures, and the activity log (`message.failed` / `scheduler.error` with `code`, `message`, `hint`) |

Providers take `auth` from `connections.getAuth(id)` rather than holding credentials, so tokens stay in the connections service. Every provider call is made with the `auth` of one explicit connection id and one explicit video id; a workflow engine only ever calls `getAuth(<its own connectionId>)`, and nothing resolves "the current account" or "the active broadcast" implicitly.

- `getStreamByVideoId(auth, videoId, { checkChat = false })` → `{ videoId, broadcastId, liveChatId, title, channelId, channelTitle, status: 'live'|'upcoming'|'ended'|'none', owned, chatAvailable, chatReadable, chatReason? }`.
  - **YouTube:** `videos.list?id=<videoId>&part=snippet,liveStreamingDetails` (1 unit) for every stream, own or external. No item → `ChatProviderError('STREAM_NOT_FOUND')` (missing, deleted, or private to another account). `status` from `snippet.liveBroadcastContent` (`live`, `upcoming`, `none`) plus `liveStreamingDetails.actualEndTime` (→ `ended`). `liveChatId` = `liveStreamingDetails.activeLiveChatId` (absent → `chatAvailable: false` with a reason). `owned` = `snippet.channelId === auth.channelId`.
  - With `checkChat: true` on an **external** live stream, a read-only `liveChatMessages.list?liveChatId=…&part=id&maxResults=…` probe (~5 units) sets `chatReadable`; a refusal (`liveChatDisabled`, `liveChatEnded`, `forbidden`, `liveChatNotFound`) yields `chatAvailable: false` with an actionable `chatReason` ("This chat cannot be accessed by the connected account"). Own streams skip the probe. `chatReadable` is never proof of posting permission. Per tick the scheduler calls it without `checkChat` (1 unit). `NOT_OWNER` is no longer produced.
  - **Test:** any well-formed id is a simulated live stream with chat (dry run, no network).
  - Errors from someone else's chat (`PERMISSION_DENIED`) must not mark the account connection as broken; only `AUTH_FAILED` and missing-scope errors do.

## Service contracts

All factories take a single options object. Return values use camelCase.

### activity — `createActivityService({ db })`
- `log({ eventType, level, connectionId?, sessionId?, provider?, category?, outcome?, messageId?, details? })` → entry. `level ∈ success|info|warning|error`. `details` is passed through `redact()` and stored as JSON (truncate to 4 KB). `connectionId` (column `activity_logs.connection_id`, migration 005) is the account the entry concerns; workflow, stream and connection events always set it.
- `list({ level?, group?, connectionId?, sessionId?, limit=100, beforeId? })` → `{ items, nextBeforeId }`. `group='scheduler'` filters `event_type LIKE 'scheduler.%'`. Items include `connectionId`; exports include it as a column.
- `recent(limit=10)`; `exportAll(filters)` → array (already sanitized; re-redact on export anyway); `clear()`.
- `countSentSince(isoTs)` → number of `message.sent` events since ts (informational; the daily limit uses `send_ledger`, see scheduler).
- Event types: `app.start`, `scheduler.start|pause|resume|stop|tick_skipped|limit_reached|error`, `message.sent|failed|created|updated|deleted|imported`, `draft.generated|approved|rejected`, `connection.added|refreshed|disconnected|removed|error`, `scheduler.review_pending|review_approved|review_rejected`, `stream.validated|selected|cleared`, `data.cleanup`.

### messages — `createMessagesService({ db, activity })`
Message shape: `{ id, text, category, enabled, source, timesSent, lastSentAt, createdAt, updatedAt }`.
- `list({ category?, q?, enabled?, limit=50, offset=0 })` → `{ items, total }` (q = case-insensitive substring).
- `get(id)` → message or throws 404.
- `create({ text, category, enabled=true, source='manual' })` → message. Throws `AppError('INVALID_MESSAGE', reason, 400)` or `AppError('DUPLICATE_MESSAGE', ..., { status: 409, details: { existingId } })`.
- `update(id, { text?, category?, enabled? })` → message (same validation; duplicate check excludes self).
- `remove(id)`; `findDuplicate(text, { excludeId })` → message|null.
- `importMessages(payload)` → `{ imported, skipped: [{ text, reason }] }`. Accepts: `{ version, messages: [{ text, category, enabled? }] }`, a bare array of those, a bare array of strings (category `compliments`), or legacy `{ "<category>": ["text", ...] }`. Unknown categories → skipped. Max 5000 items.
- `exportMessages()` → `{ version: 1, exportedAt, messages: [{ text, category, enabled }] }` (no ids/secrets).
- `stats()` → `{ total, enabled, byCategory: { [cat]: { total, enabled } } }`.
- `pickRandom({ categories?, excludeId?, random=Math.random })` → enabled message or null. Never returns `excludeId`; if the only candidate is `excludeId` return null.
- `markSent(id, isoTs)`.

### googleOAuth — `createGoogleOAuth({ config, fetch, clock })`
- `isConfigured()`; `scopes` = `['https://www.googleapis.com/auth/youtube.force-ssl']`; `redirectUri` = `${config.publicOrigin}/oauth/google/callback`.
- `createAuthorizationUrl({ reconnectId? })` → `{ url, state }`. Generates `state` (random, single use, 10 min TTL) and PKCE S256 verifier kept in memory, together with the optional connection id being re-authorized. `access_type=offline`, `prompt=consent select_account` (Google's account chooser, so each account is picked explicitly), `include_granted_scopes=true`.
- `exchangeCode({ code, state })` → `{ accessToken, refreshToken, expiresAt, scopes }`. Rejects unknown/expired/reused state with `AppError('OAUTH_STATE_INVALID', ..., 400)`.
- `refresh(refreshToken)` → `{ accessToken, expiresAt, scopes? }`; `invalid_grant` → `ChatProviderError('AUTH_FAILED')`.
- `revoke(token)` → best effort, resolves boolean.

### connections — `createConnectionsService({ db, cipher, activity, googleOAuth, chatProviders, clock })`
Public connection shape (never includes tokens): `{ id, provider, label, externalId, scopes, status, lastUsedAt, lastError, createdAt, updatedAt, isTestMode }`.
- `list()`, `get(id)` (404 if missing).
- `beginYouTubeAuth()` → `{ authUrl }` for a **new** account (throws `AppError('NOT_CONFIGURED', ..., 400)` with setup hint if no client id/secret).
- `beginReconnect(id)` → `{ authUrl }` re-authorizing an existing YouTube connection (Connect button; `POST /api/connections/:id/reconnect`).
- `completeYouTubeAuth({ code, state, error })` → connection. Calls `chatProviders.youtube.getAuthorizedChannel(auth)` for label/channel id; for a new account upserts on `(provider, external_id)` (adding an already-connected channel updates it). For a reconnect, the returned channel id must equal the connection's `external_id`; otherwise the new grant is revoked, nothing is stored and the callback reports "signed in with a different channel" (`AppError('ACCOUNT_MISMATCH', 409)`) — an account is never swapped for another. Verifies the granted scopes include `youtube.force-ssl`; if not, saves status `error` with a clear `lastError`.
- `addTestConnection({ label })` → test-provider connection (no tokens).
- `getAuth(id)` → `ChatAuth` (`{ accessToken, channelId }` or `{ test: true }`) **for that connection only**. Refreshes if expiring within 60 s and re-encrypts. Throws `ChatProviderError('AUTH_FAILED')` and sets status `error` if disconnected or refresh fails.
- `refreshStatus(id)` → connection (`POST /api/connections/:id/refresh`): refreshes the token, re-reads the channel (`channels.list`), checks the scope; updates `status`/`lastError` and logs `connection.refreshed` or `connection.error`. Errors: `AUTH_FAILED`, `PERMISSION_DENIED` (missing scope), `QUOTA_EXCEEDED`, `RATE_LIMITED`, `NETWORK` (the last three don't change the stored status).
- `markUsed(id)`, `markError(id, err)` (stores sanitized message; called only for account errors, see `isAccountError` in `errors.js`).
- `disconnect(id)` → stops that connection's workflow (via the lifecycle hook to the scheduler manager), revokes (best effort), deletes tokens, status `disconnected`. The workflow row (settings, selection) is kept.
- `remove(id)` → disconnect + delete the connection row and its workflow row; repoints `scheduler_settings.connection_id` (default workflow) away from it.
- `cleanupAll()` → stop all workflows, revoke + delete all connections.

### drafts — `createDraftsService({ db, activity, messages, aiProvider, presetProvider })`
Draft shape: `{ id, batchId, text, category, tone, language, provider, status, duplicateOf, createdAt, decidedAt }`.
- `aiStatus()` → `{ configured, provider, model, baseUrlHost }` — never the key.
- `generate({ category, tone='friendly', count=5, language='en', maxLength=150, emoji='some', length='short', source='auto'|'ai'|'preset' })` → `{ batchId, provider, drafts, rejected: [{ text, reason }] }`. `auto` uses AI when configured else preset. Sanitizes + validates every candidate, drops in-batch duplicates and candidates matching other *pending* drafts, flags library duplicates via `duplicateOf` (kept, shown with a warning).
- `list({ status='pending', batchId? })`; `update(id, { text })` (pending only, revalidates, recomputes duplicateOf).
- `approve(ids)` → `{ approved: [{ draftId, messageId }], failed: [{ draftId, reason }] }` (creates messages with `source='ai'|'preset'`).
- `reject(ids)` → `{ rejected: n }`; `clearDecided()`.

### streamSelection — `createStreamSelectionService({ db, activity, connections, chatProviders, scheduler })`
`lib/youtubeUrl.js` → `parseYouTubeUrl(input)` → `{ videoId, url }` (canonical `https://www.youtube.com/watch?v=<id>`) or throws `AppError('INVALID_STREAM_URL', 400)`. Accepts `http(s)` on `youtube.com`, `www.youtube.com`, `m.youtube.com` (`/watch?v=`, `/live/<id>`) and `youtu.be/<id>`; id must match `^[A-Za-z0-9_-]{11}$`; rejects other hosts (including look-alikes), credentials/ports in the URL, and inputs over 2 KB.
Selection shape: `{ videoId, url, title, channelTitle, connectionId, validatedAt, external, acknowledgedAt }`, stored per account in `workflows.target_*` (migration `005_multi_account.sql`; before it, the single selection lived in `scheduler_settings.target_*` from migrations 003/004, and 005 copies it to the workflow of the previously selected account). Every operation takes an explicit `connectionId` (the workflow); the legacy `/api/stream/*` routes resolve it as described under schedulerManager → default workflow. Never in browser storage. The server never fetches the user-supplied URL; only the parsed video id is sent to the YouTube API.
- `get({ connectionId })` → `{ selection: selection|null, locked }` (`locked` = that workflow running or paused).
- `validate({ url, connectionId? })` → `{ videoId, url, status: 'live'|'valid'|'offline', title, channelTitle, owned, external, chatAvailable, chatReadable, chatReason, postingPermission: 'owner'|'unverified', requiresAcknowledgement, canConnect, message, connectionId }`. Uses the given connection, else `settings.connectionId`, else the only connected account (several and none selected → 400 `NO_CONNECTION`). `valid` = upcoming; `offline` = ended or not a livestream; `canConnect` when live with chat, or valid (upcoming). `external = !owned`; `requiresAcknowledgement = external`. Provider errors (`STREAM_NOT_FOUND`, `AUTH_FAILED`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `NETWORK`) propagate as `AppError` with the same code; only auth errors call `connections.markError`. Persists nothing.
- `select({ url, connectionId?, acknowledgeExternal? })` → `{ selection, validation }`. Refuses while locked (`AppError('SCHEDULER_ACTIVE', 409)`); re-validates server-side; refuses unless `canConnect` (`STREAM_OFFLINE` / `CHAT_UNAVAILABLE`, 409); an external stream without `acknowledgeExternal: true` → 400 `ACKNOWLEDGEMENT_REQUIRED`. Stores `external` and `acknowledgedAt`. Logs `stream.selected`.
- `clear()` → `{ selection: null, locked }`. Refuses while locked (409 `SCHEDULER_ACTIVE`). Logs `stream.cleared`.

### schedulerManager — per-account workflows
Owns one scheduler **engine** (below) per connection, created lazily from the `workflows` row and keyed by `connectionId`. Engines are independent: own timer, own overlap guard (`inFlight`), own session, own failure counter, own review queue. An error in one engine never stops another.
- `list()` → `[{ connectionId, label, provider, isTestMode, connectionStatus, ...<engine status> }]` (`GET /api/workflows`).
- `get(connectionId)` → engine (404 `NOT_FOUND` for an unknown connection). All per-workflow routes go through this; there is no "current" workflow.
- `start(connectionId)` / `resume(connectionId)`: run the **cross-workflow policy check** under a single in-process lock (a promise chain, so concurrent Start requests are serialized), then delegate to the engine. With `S` = the engine's selected stream and `A` = all other active (running or paused) engines:
  - any `a ∈ A` bound to `S.videoId` → `AppError('STREAM_IN_USE', 409)`;
  - `S.external`, or any `a ∈ A` with an external selection, while `A` is non-empty → `AppError('CONCURRENT_EXTERNAL_BLOCKED', 409)`;
  - otherwise allowed (each active workflow posts to a stream owned by its own account).
  The lock is held until the engine has entered `running` (or failed), so two Starts cannot both pass the check.
- `pause/stop/approveReview/rejectReview/updateSettings(connectionId, …)` → delegate.
- Connection lifecycle hooks: `onDisconnect(id)` / `onRemove(id)` stop that engine (`stopped`, reason "Account disconnected" / "Account removed") and, for remove, delete its workflow row; `cleanupAll()` stops every engine.
- **Default workflow** (legacy `/api/scheduler/*`, `/api/stream/*`): the `connectionId` in the body/query, else `scheduler_settings.connection_id` (the previous single-account choice), else the only connected account; several accounts and none of those → 400 `NO_CONNECTION`. Never a guess among several.
- On startup, sessions left `running|paused` are marked `stopped` ("Application restarted") for every workflow; nothing auto-resumes.

### scheduler engine — `createSchedulerService({ db, activity, messages, connections, chatProviders, clock, defaultProvider, connectionId })`
One instance per workflow, bound to exactly one `connectionId` for its lifetime; it calls `connections.getAuth(connectionId)` and nothing else, and reads/writes only its own `workflows` row. Settings shape: `{ intervalSeconds (30..3600, default 120), minDelaySeconds (10..3600, default 60, <= intervalSeconds), maxMessagesPerSession (1..500, default 30), dailyLimit (null|1..2000), categories: string[] (empty = all), maxConsecutiveFailures (1..10, default 3), reviewMode (boolean, default false) }`.
- `getSettings()`, `updateSettings(patch)` (validates; allowed while running, applies from next tick).
- `start()` → status (called by the manager after the cross-workflow check). Steps: refuse if not idle (`AppError('ALREADY_RUNNING', 409)`); require a selected stream on this workflow (none → 400 `NO_STREAM_SELECTED`); `getAuth(connectionId)`; `provider.getStreamByVideoId(auth, selection.videoId, { checkChat: true })` (not live → 409 `NOT_LIVE`; no chat → 409 `CHAT_UNAVAILABLE`); refuse if daily limit already reached or no enabled messages; create `sessions` row; log `scheduler.start`; schedule first tick at `now + min(10 s, interval)`.
- `pause()`, `resume()` (resume reschedules at `max(now, lastSentAt + minDelay)` honouring interval), `stop(reason='Stopped by user')` → idempotent; clears timer, finalizes session (`stopped|completed|error`).
- `getStatus()` → `{ connectionId, state: 'idle'|'running'|'paused', session, nextRunAt, msUntilNext, inFlight, provider, isTestMode, settings, today: { sent, limit }, stream, locked, pendingReview }`. `stream` is the current selection or null; `session.videoId` is the video the session is bound to; `pendingReview` is `{ messageId, text, category, proposedAt }` or null.
- **Manual review** (`settings.reviewMode`): a tick that would send instead stores the picked message as `pendingReview`, logs `scheduler.review_pending`, and sends nothing; while one is pending, ticks pick nothing new. `approveReview()` → `{ result: { sent, providerMessageId } | { failed, message }, status }`: re-checks the selected stream (live, same chat) and the min delay, then sends through the normal send path (same confirmation, ledger and failure rules); logs `scheduler.review_approved`. Errors: `NOT_RUNNING` 409, `PAUSED` 409, `NO_PENDING_REVIEW` 409, `SEND_IN_PROGRESS` 409, `TOO_SOON` 409. `rejectReview()` → status: discards it, logs `scheduler.review_rejected`. Stopping clears any pending review.
- `tick()` → one send attempt, exported for tests. **Overlap guard:** if a tick is in flight, returns `{ skipped: 'overlap' }` and logs `scheduler.tick_skipped`. Next timer is scheduled only after the current tick completes (chained `setTimeout`, never `setInterval`).
- Tick order: limits (session max → stop `completed`; daily → stop `completed` with `scheduler.limit_reached`) → re-check **the session's video** via `getStreamByVideoId(auth, session.videoId)`: must be `live` with the same `liveChatId` (else stop `NOT_LIVE`; never another broadcast — the scheduler no longer calls `getActiveBroadcast`) → min-delay since last success → `pickRandom({ categories, excludeId: lastMessageId })` (null → stop with warning "no eligible messages") → (review mode: hold as `pendingReview` and return) → `provider.validateMessage` → `getAuth` → `sendMessage` with the `liveChatId` just resolved for the selected video. Success: `messages.markSent`, `connections.markUsed`, session counters, `message.sent` (success, details include `providerMessageId`). Failure: `message.failed` (error), `connections.markError` only for `AUTH_FAILED` / missing scope (not for a `PERMISSION_DENIED` from someone else's chat); `err.fatal` (`AUTH_FAILED`, `PERMISSION_DENIED`, `CHAT_UNAVAILABLE`, `QUOTA_EXCEEDED`, …) → stop with status `error`; non-fatal (`RATE_LIMITED`, `NETWORK`) retried only at the normal interval, consecutive failures ≥ max → stop `error`. Nothing is retried indefinitely.
- On construction, mark any `running|paused` sessions as `stopped` with reason "Application restarted" (no auto-resume).
- **Daily limit source: `send_ledger`** (migration `002_send_ledger.sql`), not the activity log. Every provider-confirmed send inserts `{ ts, connection_id, session_id, provider, provider_message_id, message_id }` (`connection_id` from migration 005); `today.sent` and the daily-limit checks count **this workflow's** ledger rows since local midnight. Clearing activity logs therefore cannot reset the limit; only `POST /api/system/cleanup` deletes the ledger. (`activity.countSentSince` still exists but is not used by the scheduler.) The migration back-fills the ledger from existing `message.sent` activity rows.

### Migration `005_multi_account.sql`
- Creates `workflows` (`connection_id` PRIMARY KEY → `account_connections.id`; the settings columns of `scheduler_settings`, `review_mode`, and `target_video_id`, `target_url`, `target_title`, `target_channel_title`, `target_validated_at`, `target_external`, `target_acknowledged_at`).
- Inserts one workflow per existing connection; the connection in `scheduler_settings.connection_id` (or the stream selection's `target_connection_id`) receives the old settings, review mode and stream selection; others get defaults.
- Adds `activity_logs.connection_id` and `send_ledger.connection_id` (back-filled from `sessions.connection_id` where a `session_id` is known) with indexes.
- Keeps `scheduler_settings` as the legacy default-workflow pointer; no token data is touched.

### terms — `createTermsService({ db, connections, activity, clock, terms })` (External Livestream Terms)
- Text: `src/legal/externalStreamTerms.js` exports `EXTERNAL_STREAM_TERMS` `{ id, version, materialVersion, effectiveDate, draft: true, title, draftNotice, sections[], acceptLabel, contentHash }`. **Draft; requires qualified legal review.** Bump `version` on every edit and `materialVersion` only for material changes.
- `record({ connectionId, videoId, accepted, termsVersion, contentHash })` → record; `409 TERMS_OUTDATED` unless version + hash match the current text; 404 for an unknown account. Appends to `terms_acknowledgements` (migration `006`; no FK so history survives account removal) storing terms/material version, hash, UTC time, account id, YouTube channel id, video id, `accepted|declined`. Logs `terms.accepted|declined` with `connectionId`.
- `isAccepted` / `requireAccepted({ connectionId, videoId })`: the latest decision for (account, video, current `materialVersion`) must be `accepted`, else `409 TERMS_ACCEPTANCE_REQUIRED` (`details.videoId`).
- `history({ connectionId?, limit })` newest first with `currentVersion`; `clearAll()` (data cleanup).
- Enforcement: `createSchedulerManager({ …, terms })` passes `requireTerms` to every engine. `start()` calls it when the saved selection is external (before any API call) and again when the live lookup says `owned === false`; `resume()` calls it for external sessions. It is an additional gate only: auth, chat, posting permission and cross-workflow rules run as before. Without `terms` (unit tests) the gate is a no-op.

## HTTP API

All `/api` state-changing requests need same-origin `Origin` and header `X-CSRF-Token` (from `GET /api/csrf`).

| Method & path | Owner | Body / query → response |
|---|---|---|
| GET `/api/csrf` | core | → `{ token }` |
| GET `/api/health` | core | → `{ ok: true, version }` |
| GET `/api/overview` | core | → `{ app: { version, chatProvider, testMode }, connections: { total, connected }, scheduler: <default workflow status>, workflows: [<workflow status>], messages: <stats>, ai: <aiStatus>, recentActivity: [...] }` |
| POST `/api/system/cleanup` | core | `{ confirm: "DELETE", includeMessages?: bool }` → stops every workflow, `connections.cleanupAll()`, clears logs/drafts/sessions (+messages) → `{ ok, removed: {...} }` |
| GET `/api/messages` | core | `?category&q&enabled&limit&offset` → `{ items, total }` |
| GET `/api/messages/stats` | core | → stats |
| POST `/api/messages` | core | `{ text, category, enabled? }` → 201 message |
| PATCH `/api/messages/:id` | core | `{ text?, category?, enabled? }` → message |
| DELETE `/api/messages/:id` | core | → 204 |
| POST `/api/messages/check-duplicate` | core | `{ text, excludeId? }` → `{ duplicate: bool, existing? }` |
| POST `/api/messages/import` | core | import payload → `{ imported, skipped }` |
| GET `/api/messages/export` | core | → attachment `messages-export.json` |
| POST `/api/messages/load-samples` | core | → import result from `samples/messages.sample.json` |
| GET `/api/drafts/ai-status` | ai | → aiStatus |
| POST `/api/drafts/generate` | ai | generate options (strict limiter) → generate result |
| GET `/api/drafts` | ai | `?status&batchId` → `{ items }` |
| PATCH `/api/drafts/:id` | ai | `{ text }` → draft |
| POST `/api/drafts/approve` | ai | `{ ids: [] }` → approve result |
| POST `/api/drafts/reject` | ai | `{ ids: [] }` → `{ rejected }` |
| DELETE `/api/drafts` | ai | → `{ cleared }` (decided drafts) |
| GET `/api/workflows` | core | → `{ items: [workflow status + { label, provider, connectionStatus }] }` |
| GET `/api/workflows/:connectionId` | core | → workflow status |
| GET / PUT `/api/workflows/:connectionId/settings` | core | settings patch → settings |
| POST `/api/workflows/:connectionId/stream/validate` | core | `{ url }` (strict limiter) → validate result |
| POST `/api/workflows/:connectionId/stream/select` | core | `{ url, acknowledgeExternal? }` (strict limiter) → `{ selection, validation }`; 409 `SCHEDULER_ACTIVE` |
| DELETE `/api/workflows/:connectionId/stream` | core | → `{ selection: null, locked }` |
| POST `/api/workflows/:connectionId/start` / `resume` | core | `{}` → status; 409 `STREAM_IN_USE` / `CONCURRENT_EXTERNAL_BLOCKED` / `NOT_LIVE` / `CHAT_UNAVAILABLE`, 400 `NO_STREAM_SELECTED` |
| POST `/api/workflows/:connectionId/pause` / `stop` | core | `{}` → status |
| POST `/api/workflows/:connectionId/review/approve` / `reject` | core | `{}` → as `/api/scheduler/review/*` |
| GET `/api/terms/external-stream` | core | → current `EXTERNAL_STREAM_TERMS` |
| GET `/api/terms/acknowledgements` | core | `?connectionId=&limit=` → `{ items: [record], current: { version, materialVersion } }` |
| POST `/api/terms/acknowledgements` | core | `{ connectionId, videoId, accepted, termsVersion, contentHash }` → 201 record; 409 `TERMS_OUTDATED`; 400; 404 |
| GET `/api/scheduler/status` | core | legacy, default workflow → status |
| GET / PUT `/api/scheduler/settings` | core | legacy, default workflow; settings patch → settings |
| POST `/api/scheduler/start` | core | legacy `{ connectionId? }` → status (default workflow; same errors as the workflow route, plus 409 `STREAM_CONNECTION_MISMATCH`) |
| POST `/api/scheduler/pause` / `resume` / `stop` | core | → status |
| POST `/api/scheduler/review/approve` | core | `{}` → `{ result, status }` (sends the pending message); 409 `NOT_RUNNING` / `PAUSED` / `NO_PENDING_REVIEW` / `SEND_IN_PROGRESS` / `TOO_SOON` |
| POST `/api/scheduler/review/reject` | core | `{}` → status (discards the pending message); 409 `NOT_RUNNING` / `NO_PENDING_REVIEW` |
| GET `/api/stream` | core | → `{ selection: null \| { videoId, url, title, channelTitle, connectionId, validatedAt, external, acknowledgedAt }, locked }` |
| POST `/api/stream/validate` | core | `{ url, connectionId? }` (strict limiter) → validate result (see streamSelection: incl. `owned`, `external`, `chatReadable`, `postingPermission`, `requiresAcknowledgement`); errors `INVALID_STREAM_URL` 400, `STREAM_NOT_FOUND` 404, `PERMISSION_DENIED` 403, auth/quota codes |
| POST `/api/stream/select` | core | `{ url, connectionId?, acknowledgeExternal? }` (strict limiter) → `{ selection, validation }`; 400 `ACKNOWLEDGEMENT_REQUIRED`; 409 `SCHEDULER_ACTIVE` / `STREAM_OFFLINE` / `CHAT_UNAVAILABLE` |
| DELETE `/api/stream` | core | → `{ selection: null, locked }`; 409 `SCHEDULER_ACTIVE` while running/paused |
| GET `/api/connections` | youtube | → `{ items, oauthConfigured, chatProvider }` |
| POST `/api/connections/youtube/start` | youtube | (strict limiter) → `{ authUrl }` |
| POST `/api/connections/test` | youtube | `{ label }` → 201 connection |
| POST `/api/connections/:id/check` | youtube | → `{ broadcast: {title, broadcastId} \| null, chat: { available, reason? } }` |
| POST `/api/connections/:id/refresh` | youtube | → connection (Refresh Status); errors `AUTH_FAILED` / `PERMISSION_DENIED` / `QUOTA_EXCEEDED` / `RATE_LIMITED` / `NETWORK` |
| POST `/api/connections/:id/reconnect` | youtube | (strict limiter) → `{ authUrl }` (Connect; callback rejects a different channel) |
| POST `/api/connections/:id/disconnect` | youtube | → connection (also stops that workflow) |
| DELETE `/api/connections/:id` | youtube | → 204 (also stops and deletes that workflow) |
| GET `/oauth/google/callback` | youtube | `?code&state&error` → 302 `/#connections` (success) or HTML error page |
| GET `/api/logs` | core | `?level&group&connectionId&sessionId&limit&beforeId` → `{ items, nextBeforeId }` |
| GET `/api/logs/export` | core | `?format=json\|csv&level&group&connectionId` → attachment (with `connectionId` column), re-redacted |
| DELETE `/api/logs` | core | `{ confirm: true }` → `{ cleared }` |

## Scripts

CLI tools under `scripts/`; testable logic lives in `scripts/lib/` (tested in `test/integration/scripts.test.js`). All use `loadConfig()`, so `DATA_DIR` from `.env` / the environment selects the database. User-facing failures throw `ScriptError` (message printed, exit code 1).

| Command | File | Behaviour |
|---|---|---|
| `npm run import -- <file.json>` | `import-messages.js`, `lib/importFile.js` | `readImportFile`: must exist, be a regular `.json` file, <= 5 MB; BOM tolerated. `importIntoDatabase(db, payload)` wires only `activity` + `messages` services and calls `importMessages(payload, { source: 'import' })` (same formats/rules as the API). Sets `busy_timeout` so it can run while the app is running. Prints imported/skipped. |
| `npm run backup` | `backup.js`, `lib/dbFiles.js` | `VACUUM INTO '<DATA_DIR>/backups/companion-<ISO stamp>.db'` (quotes doubled) — consistent online snapshot, source untouched, never overwrites. Prints the path and a warning that tokens are only usable with the same key (`TOKEN_ENCRYPTION_KEY` or `secret.key`, which is not in the backup). |
| `npm run restore -- <backup.db> --yes` | `restore.js`, `lib/dbFiles.js` | Refuses if `http://127.0.0.1:<PORT>/api/health` (and `HOST` if different) answers within 1.5 s. Validates SQLite header, `PRAGMA quick_check`, and the migration-001 tables. Without `--yes`: validation only, exit 1. With `--yes`: `VACUUM INTO companion.pre-restore-<stamp>.db`, delete `-wal`/`-shm`/`-journal`, copy the backup over `companion.db`, re-validate. Pending migrations run at next app start. |

## Frontend constraints

CSP is `script-src 'self'; style-src 'self'` → no inline `<script>`, no inline `style="..."` attributes, no `on*=` attributes. Render untrusted text with `textContent` (never `innerHTML` with data). One ES module per section under `public/js/`. All fetches go through `public/js/api.js`, which fetches the CSRF token once and sends `X-CSRF-Token` + `Content-Type: application/json`.
