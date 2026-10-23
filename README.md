# Live Chat Companion

A local, single-user dashboard that posts chat messages **from YouTube accounts you authorized, each into the live chat of the livestream you select for it** (your own, or another channel's stream where YouTube lets that account chat), on a schedule you control. Several accounts can be connected for legitimate channel administration (for example a main channel and a second channel you also run); each has its own authorization, settings, stream and scheduler. It uses only the official YouTube Data API v3 with OAuth, keeps a curated message library, and can draft new messages with an AI model (or a built-in preset library) for you to review before anything goes into the library.

It runs on your PC at `http://127.0.0.1:3000`. There is no cloud component, no login, and no telemetry.

## Policy: what this tool will and will not do

- **Your authorized accounts, YouTube's real permissions.** [Livestream Setup](#livestream-setup) accepts any YouTube livestream URL, including streams on other channels. Each workflow posts only as the one account it belongs to, which you authorized through Google OAuth, and only through the official API, so every post is subject to YouTube's actual permissions and that chat's own rules (members-only, subscribers-only, bans, slow mode, …). Knowing a URL never grants permission to post: for someone else's stream the app shows posting permission as **unverified** and treats it as confirmed only when YouTube accepts a message. Permission failures are reported as failures, never as success.
- **Owner's consent for external streams.** Selecting a stream that is not on your connected channel requires ticking an acknowledgement that you have the stream owner's permission to post automated messages there. It is enforced on the server (`400 ACKNOWLEDGEMENT_REQUIRED`), not just in the UI.
- **Several accounts, never coordinated.** You can connect several accounts, each with its own OAuth grant, encrypted tokens, settings, stream selection, scheduler workflow and audit log. The server enforces (see [Multiple accounts](#multiple-accounts)):
  - workflows may run **at the same time only when every active one posts to a stream owned by its own account** (each account administers its own channel);
  - a stream can be bound to **at most one active workflow** (`409 STREAM_IN_USE`), so two of your accounts never post into the same chat;
  - while any workflow targets an **external** stream, no other workflow may run, and vice versa (`409 CONCURRENT_EXTERNAL_BLOCKED`).

  There is no account rotation, no automatic account switching, no multi-account posting into one chat, no bypassing of chat restrictions and no anti-detection technique. Several accounts posting into the same chat, or taking turns to get around a ban, slow mode or rate limit, is coordinated inauthentic behaviour under YouTube's spam and fake-engagement policies.
- **Bound to the account and stream you chose.** Each workflow posts only as its own account to the exact video selected for it. It never silently switches to another account or to another active broadcast, even one on the same channel.
- **Supported APIs only.** Posting uses `liveChatMessages.insert` from the YouTube Data API v3. No browser automation of YouTube, no private/undocumented endpoints, no anti-detection tricks. (Playwright is used only to test this app's own dashboard.)
- **No fake success.** A message counts as "sent" only after the provider returns a message id. Failures are logged as failures.
- **No hidden automation.** Nothing posts unless you start a session. Sessions never auto-resume after a restart, they stop at your session/daily limits, and they stop on their own when the stream ends or YouTube rejects the account.
- **Human review of AI output.** Generated text lands in a draft queue; only drafts you approve become library messages.
- **Optional manual review before posting.** With **Manual review** enabled in the scheduler settings, every message the scheduler picks waits for you to **Approve & send** or **Skip**.

Be honest with your audience about automated messages, and follow YouTube's Terms of Service and Community Guidelines (spam, deceptive practices and fake engagement are not allowed).

> **Posting in other people's streams:** automated or repetitive messages in a chat whose owner has not agreed to them is exactly what YouTube's spam and fake-engagement policies prohibit. Moderators or the channel can time out or ban your account in that chat, and YouTube can restrict or strike your account. Only use external streams with the owner's explicit permission, keep the interval long, and prefer Manual review.

## Features

- **Message Studio** — library with categories (`compliments`, `sarcasm`, `witty_jokes`, `motivation`, `wholesome`), search/filter, enable/disable, duplicate detection (case/punctuation/emoji-insensitive), 200-character YouTube limit, links blocked, JSON import/export, bundled sample library.
- **AI drafts** — any OpenAI-compatible Chat Completions endpoint (OpenAI, Ollama, LM Studio, …) or the offline preset library. Drafts are validated, de-duplicated and reviewed (edit / approve / reject).
- **Livestream Setup** — paste a YouTube livestream URL (your stream or another channel's), validate it (title, channel, live/upcoming/offline, chat availability, posting-permission level), and bind the scheduler to that exact video.
- **Scheduler** — one independent workflow per account: interval (30–3600 s, default 120 s), minimum delay between sends, per-session cap, optional daily cap (counted per account), category filter, stop after N consecutive failures, pause/resume/stop, live countdown, never sends the same message twice in a row, one send at a time per workflow, optional **Manual review** mode (approve each message before it is posted).
- **Accounts** — add any number of YouTube accounts through Google OAuth (PKCE, state, offline access, Google's account chooser), plus **Test Mode** connections that never post anything. Per account: Connect (re-authorize), Refresh Status, Check stream, Disconnect, Remove. Authorization is separate from stream selection: you connect an account once, then choose a stream URL for its workflow.
- **Activity Logs** — filter by level, group and **account**, export as JSON or CSV (with the account id; secrets redacted, CSV formula-injection safe), clear.
- **Local data tools** — `npm run import`, `npm run backup`, `npm run restore`, and a "delete all local data" cleanup.

## Requirements

- **Windows 10 or 11** (the app is plain Node.js and also runs on macOS/Linux, but the instructions here are for Windows).
- **Node.js 22.13 or newer** (Node 24 LTS recommended; `package.json` declares `"engines": { "node": ">=22.13.0" }`).
  The database is SQLite via the built-in **`node:sqlite`** module (`DatabaseSync`). It needs no native compilation (no Python / Visual Studio Build Tools, no `node-gyp`), which is what makes a Windows install a plain `npm install`. `node:sqlite` is available without a flag from Node 22.13; older versions fail at startup.
- Git (to clone) — or download the source as a ZIP.
- For real posting: a Google account with a YouTube channel (posting in a live chat requires a channel; posting to your **own** stream also requires live streaming to be enabled on it), and a Google Cloud project (free) — see [Google Cloud OAuth setup](#google-cloud-oauth-setup). Every account you connect must be added as a **test user** of your OAuth consent screen. All accounts share one OAuth client and one project quota.

## Install on Windows (PowerShell)

```powershell
# 1. Node.js LTS (skip if `node --version` already prints v22.13+ / v24)
winget install OpenJS.NodeJS.LTS
# close and reopen PowerShell so `node` and `npm` are on PATH
node --version

# 2. Get the code
git clone <repository-url> live-chat-companion
cd live-chat-companion

# 3. Dependencies
npm install

# 4. Configuration
Copy-Item .env.example .env

# 5. (Recommended) generate a token encryption key and paste it into .env as TOKEN_ENCRYPTION_KEY=...
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
notepad .env
```

If `TOKEN_ENCRYPTION_KEY` is left empty, the app generates a random key on first start and stores it in `data\secret.key`. Either way, keep the key: it is required to decrypt stored OAuth tokens (see [Backup and restore](#backup-and-restore)).

### Run

Exact PowerShell commands, from the project folder:

```powershell
# Start the dashboard (Ctrl+C to stop), then open http://127.0.0.1:3000
npm start

# Unit + integration tests (mocked providers; nothing is posted anywhere)
npm test

# Browser tests of the dashboard (one-time browser download first)
npx playwright install chromium
npm run test:e2e
```

| Command | What it does |
|---|---|
| `npm start` | Start the server (`node src/server.js`). |
| `npm run dev` | Start with auto-restart when files in `src/` or `public/` change (`node --watch-path=src --watch-path=public`). |
| `npm test` | Unit + integration tests (`node --test`). No network, no real accounts. |
| `npm run test:e2e` | Playwright browser tests of the dashboard. Run `npx playwright install chromium` once first. |
| `npm run import -- <file.json>` | Import an existing messages JSON file into the database. |
| `npm run backup` | Online database backup to `data\backups\`. |
| `npm run restore -- <backup.db> --yes` | Restore a backup (app must be stopped). |

Then open **http://127.0.0.1:3000** in your browser. Out of the box `CHAT_PROVIDER=test`, so you can try everything in Test Mode before setting up Google.

> Use `127.0.0.1` (or `localhost`) with the configured port exactly. Requests with any other `Host` header are rejected with `403 BAD_HOST` as DNS-rebinding protection.

### Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Keep it on loopback. A non-loopback value logs a warning: the dashboard has no login. |
| `PORT` | `3000` | Must match the port in your Google OAuth redirect URI. |
| `DATA_DIR` | `./data` | SQLite database (`companion.db`), `secret.key`, `backups\`. Relative to the project root. |
| `TOKEN_ENCRYPTION_KEY` | empty | 64 hex chars (32 bytes). Empty → generated into `DATA_DIR\secret.key`. Invalid → startup error. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | placeholders | From your OAuth client. |
| `CHAT_PROVIDER` | `test` | `test` = dry run, nothing is posted; `youtube` = real posting. |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible base URL (the app calls `<base>/chat/completions`). |
| `AI_MODEL` | `gpt-4o-mini` | Model name for that endpoint. |
| `AI_API_KEY` | empty | Empty → AI disabled; drafts come from the preset library. |
| `AI_TIMEOUT_MS` | `30000` | Per-request timeout for AI calls. |

Restart the app after editing `.env`.

## Google Cloud OAuth setup

You need this only for real posting (`CHAT_PROVIDER=youtube`).

1. **Create a project.** Open https://console.cloud.google.com/ → project picker → **New project** → name it (e.g. "Live Chat Companion") → **Create**, and select it.
2. **Enable the API.** **APIs & Services → Library** → search **"YouTube Data API v3"** → **Enable**.
3. **OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding / Audience / Data access**):
   - User type / Audience: **External**.
   - App name, user support email, developer contact email: fill in.
   - Scopes / Data access: **Add or remove scopes** → add `https://www.googleapis.com/auth/youtube.force-ssl` ("See, edit, and permanently delete your YouTube videos, ratings, comments and captions"; this is the scope `liveChatMessages.insert` requires).
   - Publishing status: leave it in **Testing**.
   - **Test users: add every Google account you will connect** (the account behind each channel). Only test users can authorize an app in Testing mode; an account that is not listed gets `Error 403: access_denied`. Testing mode allows up to 100 test users.
4. **Create credentials.** **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs**: add exactly
     `http://127.0.0.1:3000/oauth/google/callback`
     (it must match `HOST` and `PORT`; if you change `PORT` to 3100, use `http://127.0.0.1:3100/oauth/google/callback`. Use `127.0.0.1`, not `localhost`, because the app builds the redirect URI from `HOST`).
   - **Create**, then copy the **Client ID** and **Client secret**.
5. **Configure the app.** In `.env`:
   ```ini
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   CHAT_PROVIDER=youtube
   ```
   Restart (`Ctrl+C`, then `npm start`).

   > Put the real values only in `.env` (which is gitignored), never in `.env.example`. If a real client secret was ever written to `.env.example` or shared anywhere, **rotate it**: Google Cloud → Credentials → your OAuth client → **Reset secret** (or add a new secret and delete the old one), then update `.env`.
6. **Connect.** Dashboard → **Accounts** → **Add YouTube Account** → Google's account chooser opens (`prompt=select_account`) → pick a test-user account → allow access. Repeat **Add YouTube Account** for each further account; every account authorizes separately and gets its own tokens. If a browser profile is already signed in to several Google accounts, check which one you pick in the chooser.
   - In Testing mode Google shows **"Google hasn't verified this app"**. This is expected for your own private project: choose **Continue** (sometimes under **Advanced**).
   - Allow every requested permission. If the YouTube permission is unticked, the connection is saved with status `error` ("Missing required permission …") and the grant is revoked; reconnect and allow it.
   - Adding the same channel a second time updates its existing connection instead of creating a duplicate.
   - The redirect URI is the same for every account (`http://127.0.0.1:3000/oauth/google/callback`); nothing changes in Google Cloud when you add accounts.
7. **Refresh tokens expire after 7 days in Testing mode, per account.** Google limits refresh tokens for apps whose publishing status is *Testing* (with external user type) to 7 days, counted separately for each account from when it authorized. After that that account's Refresh Status, check or workflow fails with an authorization error (`invalid_grant` → `AUTH_FAILED`) and its workflow stops; other accounts are not affected. Use **Connect** on that account to re-authorize it. Moving the app to *In production* removes the 7-day limit but `youtube.force-ssl` is a sensitive scope that may require Google verification; for personal use, re-authorizing weekly is the simplest option.

### YouTube API quota

Costs per Google's quota calculator (https://developers.google.com/youtube/v3/determine_quota_cost); new projects get **10,000 units/day** (resets at midnight Pacific Time). **The quota belongs to the Google Cloud project, not to an account:** every connected account and every running workflow draws from the same 10,000 units/day.

| Call | When | Cost |
|---|---|---|
| `channels.list` | once per connect / re-authorize, and on Refresh Status | 1 unit |
| `videos.list?part=snippet,liveStreamingDetails` | Validate / Connect to Stream, start, and **every tick** (to confirm the selected video is still live with the same chat) | 1 unit |
| `liveChatMessages.list` (read-only probe) | Validate / Connect / start for an **external** live stream, to check its chat is accessible to your account | ~5 units |
| `liveBroadcasts.list?broadcastStatus=active` | Accounts → Check stream | 1 unit |
| `liveChatMessages.insert` | every send | 20 units |

Validate and Connect cost 1 unit for your own stream and about 6 units for an external live stream (`videos.list` + the chat probe). Example: a 2-minute interval for 3 hours ≈ 90 posts ≈ **1,800 units** for inserts, plus about 1 unit per tick for the stream check (~90+) — roughly 1,900 units. The default quota therefore allows only about 500 posts per day **in total across all accounts**; two workflows running side by side use it up twice as fast. If you hit `quotaExceeded` every workflow's next call fails and those sessions stop (see [Troubleshooting](#troubleshooting)). Use each workflow's daily limit to stay well under the shared quota.

## AI provider

Drafts are generated through the OpenAI-compatible Chat Completions API (`POST <AI_BASE_URL>/chat/completions` with `Authorization: Bearer <AI_API_KEY>`). AI is enabled only when `AI_API_KEY`, `AI_BASE_URL` and `AI_MODEL` are all set.

```ini
# OpenAI
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-...

# Ollama (local) — `ollama pull llama3.1` first. Ollama ignores the key, but the app needs a non-empty value.
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.1
AI_API_KEY=ollama

# LM Studio (local server tab → Start server)
AI_BASE_URL=http://127.0.0.1:1234/v1
AI_MODEL=<model id shown in LM Studio>
AI_API_KEY=lm-studio
```

**Without a key** everything still works: the generator uses the built-in **preset library** (source "auto" falls back to presets; "preset" forces it; "ai" without a key returns `400 NOT_CONFIGURED`). The key never leaves the server: the dashboard sees only `configured`, provider name, model and base-URL host, and the key is masked in all errors and logs.

AI output is treated as untrusted: every candidate is sanitized, checked against the 200-character limit and the no-links rule, de-duplicated against the batch, pending drafts and your library (library duplicates are flagged), and only stored as a **pending draft**.

## Test Mode

`CHAT_PROVIDER=test` (the default) and "Test Mode" connections use a dry-run provider: it simulates an always-live broadcast, treats any well-formed livestream URL in Livestream Setup as a live stream with chat, runs the full scheduler flow (limits, delays, logging), and returns message ids prefixed `test-`, but **performs no network I/O and posts nothing anywhere**. The dashboard shows a Test Mode banner. Use it to tune intervals and your library before going live.

## Livestream Setup

The **Livestream Setup** card at the top of the Scheduler view selects the exact stream the selected account's workflow posts to. Every account has its own selection.

1. Pick the **account** in the Scheduler view's account selector.
2. Paste the stream URL. Accepted formats (`http` or `https`, with `www.`, `m.` or no subdomain):
   - `https://www.youtube.com/watch?v=VIDEO_ID`
   - `https://youtu.be/VIDEO_ID`
   - `https://www.youtube.com/live/VIDEO_ID`

   The video id must be exactly 11 characters (`A–Z a–z 0–9 _ -`). Other hosts (including look-alikes such as `youtube.com.example.com`), other paths, and malformed ids are rejected with `INVALID_STREAM_URL`. The URL is stored in canonical form (`https://www.youtube.com/watch?v=VIDEO_ID`).
   The URL is only parsed; the server never fetches the URL you paste. It looks up the extracted video id through the YouTube Data API.
3. **Validate Stream** asks YouTube about the video without saving anything (`videos.list` with `snippet,liveStreamingDetails`; for an external live stream also a read-only `liveChatMessages.list` probe of its chat). The status pill shows:

   | Status | Meaning |
   |---|---|
   | Not checked | No validation has run yet. |
   | Valid | The stream exists and is scheduled/upcoming (not live yet). You can select it; the scheduler starts only once it is live. |
   | Live | Live now and its live chat is active (and, for external streams, readable by your account). |
   | Offline | The stream has ended (chat replay only), or the video is not a livestream. |
   | Error | Invalid URL, video not found or private, chat disabled or not accessible, authorization/permission failure, quota or network error. The message says what to do. |

   The detected stream title and channel name are shown when available. A stream is only reported as Live after YouTube confirms its status. The result distinguishes three separate things:

   | Level | How it is known |
   |---|---|
   | **Video viewable** | `videos.list` returned the video (public or unlisted, or private on your own channel). |
   | **Live with an active chat** | `liveBroadcastContent` is `live` and `liveStreamingDetails.activeLiveChatId` is present; for external streams the chat probe also succeeded (chat **readable**). |
   | **Posting permission** | **owner** for your own channel's stream. **unverified** for an external stream: YouTube has no API to ask "may this account post here?" in advance, so it is only confirmed when YouTube accepts the first message. A successful video lookup is never treated as permission to post. |
4. For a stream on **another channel**, tick **"I have the stream owner's permission to post automated messages in this chat"**. Without it, Connect is refused (`400 ACKNOWLEDGEMENT_REQUIRED`).
5. **Connect to Stream** validates again on the server and saves the selection (video id, canonical URL, title, channel, whether it is external, when you acknowledged) on that account's workflow in the local SQLite database. It is not kept in browser storage, and OAuth tokens never reach the browser.
6. **Clear selection** removes the saved stream. It does not disconnect your Google account.

Rules:

- The selection cannot be changed or cleared while that account's workflow is running or paused (`409 SCHEDULER_ACTIVE`). Stop it first. Other accounts' workflows are unaffected.
- **Start requires a selected stream** (`NO_STREAM_SELECTED`), and the stream must be live with chat available at start.
- The selection belongs to the account whose workflow it is on; it is never used by, or moved to, another account. To post to the same stream from a different account you would have to select it there, and the [multi-account rules](#multiple-accounts) decide whether that may run.
- While a session runs, every tick re-checks **that exact video** (1 unit) before sending, and the chat id is resolved from the selected video right before each send. The session stops if the stream ends, its chat id changes or chat becomes unavailable, or authorization or permission is lost. It never falls back to another broadcast, including your own channel's current broadcast.
- Permission, policy and quota errors (`PERMISSION_DENIED`, `CHAT_UNAVAILABLE`, `QUOTA_EXCEEDED`, `AUTH_FAILED`) stop the session at once. Rate limits (`RATE_LIMITED`, e.g. slow mode) are retried only at the normal interval and stop the session after **Max consecutive failures**; nothing is retried indefinitely.
- A `PERMISSION_DENIED` from someone else's chat (members-only, banned, …) does **not** mark your account connection as broken; only authorization failures and a missing scope do.
- The selected stream is shown prominently in the Scheduler view and on Overview while the scheduler is running.

### Manual review mode

Enable **Manual review** in the scheduler settings. Each tick then picks a message as usual but does not post it: the **Live status** card shows it with **Approve & send** and **Skip**.

- **Approve & send** re-checks that the selected stream is still live with chat and that the minimum delay has passed, then posts. Errors: `TOO_SOON` (minimum delay not reached), `SEND_IN_PROGRESS` (a send is already running), `NO_PENDING_REVIEW` (nothing waiting, e.g. it was already handled), `NOT_RUNNING`, `PAUSED` (resume first).
- **Skip** discards it; the next tick picks another message.
- While a message waits, no other message is picked. Each account's workflow has its own review queue. API: `POST /api/workflows/:connectionId/review/approve` and `…/review/reject` (the legacy `POST /api/scheduler/review/approve|reject` act on the default workflow); the workflow status includes `pendingReview`.

### External Livestream Terms (responsibility confirmation)

> **Draft.** The terms text in `src/legal/externalStreamTerms.js` has **not** been reviewed by a lawyer. It must receive qualified legal review before the app or the terms are distributed publicly.

**Purpose.** Before a scheduler starts (or resumes) on a livestream that is **not owned by its account**, the app shows a modal with the complete *External Livestream Terms and Responsibility Confirmation* and records your decision locally. It makes the responsibilities explicit: you confirm that the stream owner (or an authorized moderator) agreed to scheduled messages, that you will follow YouTube's rules and the channel's chat rules, and that you will stop if asked.

**How it works**
- Press **Start** on an external stream without a current acceptance: the server refuses with `409 TERMS_ACCEPTANCE_REQUIRED` and the dashboard opens the modal. The checkbox stays disabled until the end of the terms has been scrolled into view; **Accept and continue** stays disabled until it is ticked. **Decline** is recorded as a decline; closing the modal (Escape) records nothing. After accepting, the start is retried once.
- An acceptance is valid for **one account + one livestream + the current material version** of the terms. A later decline withdraws it (resume is refused too). The check runs on the server at Start (from the saved selection and again after the live ownership lookup) and at Resume.
- **Versioning:** every edit changes `version`; only a **material** change bumps `materialVersion`, which requires everyone to accept again. A decision is accepted only for the exact text shown (version + SHA-256 fingerprint); otherwise `409 TERMS_OUTDATED` and the modal reloads the new text.
- **Record** (table `terms_acknowledgements`, migration `006_terms_acknowledgements.sql`, append-only): terms version, material version, text fingerprint, UTC timestamp, local account id, YouTube channel id, video id, `accepted`/`declined`. No passwords, tokens, email addresses or message text. Kept when an account is removed; deleted by **Delete all local data**.
- **Terms** page (sidebar): the current text and every previous decision, marked *Current version* / *Older version*.
- API: `GET /api/terms/external-stream`, `GET /api/terms/acknowledgements?connectionId=&limit=`, `POST /api/terms/acknowledgements` `{ connectionId, videoId, accepted, termsVersion, contentHash }`. Activity events `terms.accepted` / `terms.declined` (Scheduler group).

**Limitations**
- Accepting is **not** authorization. It is not permission from YouTube or the stream owner, it does not verify that the owner agreed, and it replaces none of the app's checks: OAuth, chat availability, posting permission (YouTube still decides per message), the one-external-workflow rule and the session limits all still apply.
- It is **not** a liability shield. Accepting does not protect you from account restrictions, platform enforcement, complaints, lawsuits or regulatory action, and the terms do not limit anyone else's rights.
- It is a local record on your PC that you can delete; it is not tamper-proof evidence. Test Mode streams count as owned, so the modal only appears for real external YouTube streams.

## Multiple accounts

Connect several accounts when you administer several channels. Each connection has a unique id and its own:

- OAuth grant and AES-256-GCM encrypted tokens (never sent to the browser);
- workflow: scheduler settings, Manual review switch, selected livestream, session, countdown, controls and status;
- daily limit (counted from that account's confirmed sends);
- audit trail: every activity-log entry carries the account's connection id; filter by account in Activity Logs.

### Accounts page

| Control | What it does |
|---|---|
| **Add YouTube Account** | Starts a new Google OAuth authorization with the account chooser (`prompt=select_account`). The new connection appears once you return. Adding a channel that is already connected updates that connection. |
| **Connect** | Re-authorizes an existing account (after `AUTH_FAILED`, an expired 7-day Testing token, a missing permission, or Disconnect). If you sign in with a Google account whose channel differs from this connection's channel, the authorization is **rejected** and the connection is left unchanged; the app never swaps one account for another. |
| **Refresh Status** | Refreshes the access token, re-reads the channel (`channels.list`, 1 unit) and checks the granted scope. Reports `connected`, or the error: `AUTH_FAILED` (expired or revoked authorization → Connect), `PERMISSION_DENIED` (missing `youtube.force-ssl` → Connect and allow all permissions), `QUOTA_EXCEEDED`, `RATE_LIMITED`, `NETWORK`. |
| **Check stream** | Shows whether this account's own channel is live (`liveBroadcasts.list`, 1 unit). |
| **Disconnect** | Stops this account's workflow, revokes the grant at Google (best effort) and deletes its tokens. The workflow's settings and stream selection are kept so you can Connect again. |
| **Remove** | Disconnects (as above) and deletes the connection and its workflow. Activity-log history stays, still tagged with the old connection id. |

### Scheduler and Overview

- The Scheduler view has an **account selector**. Livestream Setup, settings, Live status, Start / Pause / Resume / Stop and the review panel all act on the selected account's workflow only.
- **Overview → Workflows** lists every account with its state, selected stream, countdown and its own Start / Stop.
- Every workflow has its own overlap guard (one send at a time), and stops on its own errors without touching other workflows. An authorization error marks only that account's connection.

### What runs concurrently (enforced at Start)

| Situation | Allowed? |
|---|---|
| Account A posts to A's own stream while account B posts to B's own stream | **Yes** |
| Two accounts' workflows bound to the **same** stream, both active | **No** — `409 STREAM_IN_USE` |
| Any workflow on an **external** stream while another workflow is running or paused | **No** — `409 CONCURRENT_EXTERNAL_BLOCKED` (also the other way round) |
| Switching to another account when one is banned, rate-limited or out of daily limit | **Never** — the workflow stops; nothing is moved to another account |

These checks run on the server under a lock at Start (and Resume), so two Start clicks cannot both get through. "Active" means running or paused.

### Errors per account

| Code | Meaning for that account |
|---|---|
| `AUTH_FAILED` | Authorization expired (7 days in Testing mode) or was revoked. The workflow stops; use **Connect**. |
| `PERMISSION_DENIED` | Missing `youtube.force-ssl` scope (connection marked `error`; Connect and allow all), or the target chat refused the post (members-only, banned, …; connection not marked). |
| `CHAT_UNAVAILABLE` | Chat disabled, ended, or not accessible to this account. |
| `RATE_LIMITED` | YouTube asked this account to slow down (e.g. slow mode). Retried only at the normal interval; stops after Max consecutive failures. |
| `QUOTA_EXCEEDED` | The shared project quota is used up; affects every account until midnight Pacific Time. |

### API

| Method + path | Purpose |
|---|---|
| `GET /api/workflows` | All workflows with status. |
| `GET /api/workflows/:connectionId` | One workflow's status. |
| `GET` / `PUT /api/workflows/:connectionId/settings` | That workflow's settings. |
| `POST /api/workflows/:connectionId/stream/validate` · `…/stream/select`, `DELETE …/stream` | That workflow's Livestream Setup. |
| `POST /api/workflows/:connectionId/start` · `…/pause` · `…/resume` · `…/stop` | Lifecycle. |
| `POST /api/workflows/:connectionId/review/approve` · `…/review/reject` | Manual review. |
| `POST /api/connections/:id/refresh` · `POST /api/connections/:id/reconnect` | Refresh Status · Connect (re-authorize). |
| `GET /api/logs?connectionId=…` | Account-filtered activity log (also on the export endpoints). |

The older `/api/scheduler/*` and `/api/stream/*` routes still work. They act on the **default workflow**: the `connectionId` in the body or query, else the account previously selected in the single-account scheduler, else the only connected account. With several accounts and none of those, they return `400 NO_CONNECTION` rather than guess.

### Supported vs restricted external-stream scenarios

| Scenario | Result |
|---|---|
| Public or unlisted live stream with open chat | **Supported.** Validates as Live (permission unverified); posts as your account if YouTube accepts it. |
| Upcoming (scheduled) stream | **Supported.** Select it now (Valid); Start succeeds only once it is live. |
| Your own channel's stream | **Supported.** Posting permission shown as owner. |
| Members-only chat | **Restricted by YouTube.** Only channel members can post; send fails with `PERMISSION_DENIED` and the session stops. |
| Subscribers-only chat | **Restricted by YouTube.** Requires subscribing (sometimes for a minimum time); otherwise `PERMISSION_DENIED`. |
| Account banned or timed out in that chat | **Restricted by YouTube.** `PERMISSION_DENIED`; the session stops. |
| Slow mode | **Restricted by YouTube.** Limits how often you can post; sends faster than allowed fail (`RATE_LIMITED`) and count toward Max consecutive failures. Use a longer interval. |
| Chat disabled, or not accessible to your account | **Restricted by YouTube.** Validation shows Error / chat unavailable; Connect is refused. |
| Private video on another channel | **Restricted by YouTube.** `STREAM_NOT_FOUND`. |
| Ended stream (chat replay) | **Restricted by YouTube.** Offline; cannot be selected. |
| Age- or region-restricted streams, accounts without a channel | **Restricted by YouTube.** Surfaces as `PERMISSION_DENIED` or `STREAM_NOT_FOUND`. |
| Several of your accounts in the same chat, account rotation, bypassing restrictions, browser automation, undocumented endpoints | **Not supported by this app, by design.** Only one workflow may run while any workflow targets an external stream. |

## Using the dashboard

- **Overview** — **Workflows** card (every account's state, selected stream, countdown, Start / Stop), connection count, library stats, AI status, recent activity.
- **Message Studio** — add/edit/enable/disable/delete messages, search and filter by category, check for duplicates, import a JSON file (any format listed under [Migrating](#migrating-an-old-messagesjson)), export, load the sample library. Generate AI/preset drafts (category, tone, language, count, length, emoji), then edit, approve or reject them.
- **Scheduler** — choose the **account**, select its livestream in [Livestream Setup](#livestream-setup), set its settings (optionally **Manual review**), then Start / Pause / Resume / Stop that account's workflow. With Manual review on, approve or skip each pending message in the Live status card. Start fails with a clear error if no stream is selected (`NO_STREAM_SELECTED`), the selected stream is not live (`STREAM_OFFLINE` / `NOT_LIVE`), chat is unavailable, another active workflow uses the same stream (`STREAM_IN_USE`) or an external stream is involved while another workflow is active (`CONCURRENT_EXTERNAL_BLOCKED`), there are no enabled messages, or the account's daily limit is reached. Settings changed while running apply from the next tick.
- **Accounts** — Add YouTube Account, add a Test Mode connection, and per account Connect, Refresh Status, Check stream, Disconnect (stops its workflow, revokes at Google, deletes tokens) or Remove (see [Accounts page](#accounts-page)). Authorization only: the target stream is chosen separately in Livestream Setup. The **Danger zone** deletes all local data.
- **Activity Logs** — every start/stop, send, failure, import, draft decision and connection event, tagged with the account it concerns; filter by level (`success`, `info`, `warning`, `error`), group (`scheduler`, `messages`, `drafts`, `connections`, `system`) and account; export JSON/CSV (includes `connectionId`); clear.

## Security model

- **Loopback only.** The server binds to `HOST` (default `127.0.0.1`), so it is not reachable from your network.
- **Host check.** Requests whose `Host` is not `127.0.0.1:<PORT>` / `localhost:<PORT>` are rejected (DNS-rebinding protection).
- **Origin + CSRF.** Every state-changing `/api` request needs a same-origin `Origin` (or `Referer`) **and** an `X-CSRF-Token` header matching a per-process token from `GET /api/csrf` (other sites cannot read it).
- **Rate limits.** 300 requests/minute on `/api` and `/oauth`; 10/minute on AI generation, YouTube connect/reconnect, stream validation and data cleanup. Exceeding returns `429 RATE_LIMITED`.
- **Headers.** Strict CSP (`script-src 'self'; style-src 'self'`, no inline script/style, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP same-origin, no `X-Powered-By`.
- **Static files** are served from `public/` only, without dotfiles; path traversal (`/..%2f..`, `/.env`) returns 404.
- **No passwords.** The app never asks for or stores Google passwords, cookies or verification codes. Every account authorizes on Google's own sign-in page through OAuth.
- **Token encryption, per account.** Each connection's OAuth access/refresh tokens are stored only AES-256-GCM encrypted (`v1:<iv>:<tag>:<ciphertext>`) in its own `account_connections.encrypted_tokens` row, with the key from `TOKEN_ENCRYPTION_KEY` or `data\secret.key`. A workflow can only obtain the tokens of its own connection. **Limits:** this protects a copied or exported database file. It does **not** protect against malware or another person who can read your Windows user profile, because the key file (or `.env`) is on the same disk. Disconnecting an account deletes its tokens and revokes them at Google (best effort); other accounts are untouched.
- **No secrets leave the server.** No API route returns tokens, client secret or AI key; frontend JavaScript only sees account labels, channel ids, status and scopes. Every console line, activity-log entry (for every account), API error and export is passed through redaction (Bearer tokens, `ya29.` access tokens, `1//` refresh tokens, `sk-` keys, `GOCSPX-` secrets, `AIza` keys, token-like query/JSON fields, and the configured secret values).
- **Input validation.** All request bodies/queries are validated with zod (unknown fields rejected); message text is sanitized (control and invisible characters removed) and validated; the OAuth `state` is single-use with PKCE (S256).
- **Not committed** (`.gitignore`): `.env` and `.env.*` (except `.env.example`), `*.key`, `secrets/`, `client_secret*.json`, `credentials*.json`, `token*.json`, `data/`, `*.db` and SQLite `-journal`/`-wal`/`-shm` files, `exports/`, `backups/`, logs and test output.

## Data model

SQLite file `DATA_DIR\companion.db` (WAL mode). Migrations in `src/db/migrations/` are applied automatically at startup.

| Table | Contents |
|---|---|
| `messages` | Library: text, normalized text (UNIQUE, for duplicate detection), category, enabled, source (`manual`/`import`/`ai`/`preset`), times sent, last sent. |
| `account_connections` | One row per connected channel or Test Mode connection, keyed by a unique id: label, channel id, granted scopes, status, **encrypted** tokens, last error (sanitized). |
| `workflows` | One row per connection (migration `005_multi_account.sql`): that account's scheduler settings (interval, min delay, per-session and daily limits, categories, max consecutive failures), `review_mode`, and its selected livestream (`target_video_id`, `target_url`, `target_title`, `target_channel_title`, `target_validated_at`, `target_external`, `target_acknowledged_at`). |
| `scheduler_settings` | **Legacy** single row from migrations 001–004. Now only a pointer to the default workflow (`connection_id`) used by the old `/api/scheduler/*` and `/api/stream/*` routes; its other columns are no longer read. |
| `sessions` | One row per workflow session: account (`connection_id`), selected video (`video_id`), broadcast, status (`running`/`paused`/`stopped`/`error`/`completed`), sent/failed counts, stop reason. |
| `activity_logs` | Redacted event log shown in Activity Logs; `connection_id` (migration 005) records which account an entry concerns. |
| `generated_drafts` | AI/preset drafts and their review status. |
| `send_ledger` | Append-only record of provider-confirmed sends, with `connection_id` (migration 005). **Each account's daily limit is counted from here**, so clearing activity logs cannot reset it. Only the full data cleanup removes it. |
| `terms_acknowledgements` | Append-only External Livestream Terms decisions (migration `006_terms_acknowledgements.sql`): terms version, material version, text fingerprint, UTC time, account id, YouTube channel id, video id, accepted/declined. No secrets or email addresses. |
| `schema_migrations` | Applied migration files. |

## Backup and restore

```powershell
# Online backup (safe while the app is running) -> data\backups\companion-<timestamp>.db
npm run backup

# Restore: stop the app first (Ctrl+C). Without --yes it only validates and shows what would happen.
npm run restore -- "data\backups\companion-2026-10-20T22-53-01-123Z.db"
npm run restore -- "data\backups\companion-2026-10-20T22-53-01-123Z.db" --yes
```

- Backups use SQLite `VACUUM INTO`, producing a consistent snapshot even while the app writes.
- `restore` refuses to run while anything answers on `http://127.0.0.1:<PORT>/api/health`, checks the file is an intact SQLite database with this app's tables, saves the current database as `data\companion.pre-restore-<timestamp>.db`, removes stale `-wal`/`-shm` files, then replaces `companion.db`. Missing newer tables (e.g. `send_ledger` in an old backup) are created by migrations on next start.
- **The encryption key is not in the backup.** Back up `data\secret.key` (or your `TOKEN_ENCRYPTION_KEY` value) separately and securely — e.g. in a password manager — not next to the database backups. Backups contain no plaintext secrets. If you restore without the same key, messages, settings and logs are fine but connected accounts show an error ("Stored credentials could not be read") and must be **reconnected**.
- `DATA_DIR` from `.env` (or the environment) decides which database the scripts use.

## Disconnect and local data cleanup

1. **Accounts → Disconnect** (per account) stops that account's workflow, revokes its grant at Google (best effort) and deletes its stored tokens; **Remove** also deletes the connection row and its workflow.
2. **Accounts → Danger zone → Delete all local data** (asks for confirmation; API: `POST /api/system/cleanup` with `{ "confirm": "DELETE" }`) stops every workflow, revokes and deletes all connections, and clears workflows, activity logs, drafts, sessions, the send ledger and the terms acknowledgement history. Tick the option to delete the message library too (`includeMessages: true`).
3. Also remove the app's access in **each** Google account: https://myaccount.google.com/permissions → the app → **Remove access** (covers the case where revocation failed or the app was offline).
4. To remove everything, stop the app and delete the `data\` folder (database, key, backups) and `.env`.

## Upgrading to multi-account (migration instructions)

Upgrading from the single-account version keeps your data. Run in PowerShell from the project folder:

```powershell
# 1. Stop the app (Ctrl+C in the window running npm start), then back up the database
npm run backup
# also keep a copy of the encryption key (it is not in the backup)
Copy-Item data\secret.key "$env:USERPROFILE\Documents\live-chat-companion-secret.key"   # skip if you use TOKEN_ENCRYPTION_KEY in .env

# 2. Update the code
git pull                # or replace the folder with the new ZIP, keeping .env and data\

# 3. Dependencies
npm install

# 4. Start; migrations 004_external_review.sql, 005_multi_account.sql and 006_terms_acknowledgements.sql apply automatically
npm start
```

What migration 005 does:

- Creates the `workflows` table with **one workflow per existing connection**.
- Copies your previous scheduler settings, Manual review switch and selected livestream (including the external flag and acknowledgement time) into the workflow of the account that was selected in the old scheduler. Other existing accounts get default settings and no stream selection.
- Adds `connection_id` to `activity_logs` and `send_ledger`; old entries of the previously selected account are attributed to it where the old session records it, otherwise they stay without an account.
- Leaves `scheduler_settings` in place as the pointer to the default workflow, so the old `/api/scheduler/*` and `/api/stream/*` routes keep working.
- Does not touch tokens: existing connections keep working with the same encryption key.

After starting:

- Open **Scheduler**, pick each account and check its settings and stream. **Validate the stream again** before starting, especially an external one (live status and chat access may have changed since it was selected).
- Add further accounts with **Accounts → Add YouTube Account** (add them as Test users in Google Cloud first).

**Roll back** (back to the previous version and data):

```powershell
# stop the app (Ctrl+C), go back to the previous code (e.g. git checkout <previous commit>), then:
npm install
npm run restore -- "data\backups\companion-<timestamp>.db"          # validates, shows what will happen
npm run restore -- "data\backups\companion-<timestamp>.db" --yes    # restores; current DB saved as data\companion.pre-restore-<timestamp>.db
npm start
```

Restore with the same encryption key, or connected accounts must be re-authorized. Accounts added after the upgrade are not in the old backup.

## Migrating an old messages.json

```powershell
npm run import -- "C:\path\to\messages.json"
```

Accepted formats (same as the dashboard import; max 5 MB, max 5,000 messages, UTF-8 with or without BOM):

```jsonc
{ "version": 1, "messages": [ { "text": "Great stream!", "category": "compliments", "enabled": true } ] }
[ { "text": "Great stream!", "category": "compliments" } ]
[ "Great stream!", "Love this" ]                                  // category "compliments"
{ "compliments": ["Great stream!"], "witty_jokes": ["..."] }        // legacy format
```

The script prints how many were imported and lists skipped entries with the reason (duplicate, unknown category, too long, contains a link, …). Existing messages are never overwritten. It can run while the app is running.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Port 3000 is already in use. Set PORT in .env.` | Another process uses the port. Find it: `Get-NetTCPConnection -LocalPort 3000 \| Select OwningProcess` then `Get-Process -Id <pid>`. Or set another `PORT` **and** update the redirect URI in Google Cloud. |
| Google: `Error 400: redirect_uri_mismatch` | The Authorized redirect URI must be exactly `http://<HOST>:<PORT>/oauth/google/callback` (default `http://127.0.0.1:3000/oauth/google/callback`) — same host, port, no trailing slash, client type **Web application**. |
| Google: `Error 403: access_denied` / "has not completed the Google verification process" | The account is not a **test user** of your OAuth consent screen. Add it (every account you connect) under Test users. If you clicked Cancel, the dashboard shows "Authorization was cancelled or denied". |
| Connection status `error`: "Missing required permission … (youtube.force-ssl)" / `insufficientPermissions` / `AUTH_FAILED` | Reconnect and allow all permissions; make sure the scope is added to the consent screen. The Google account must also have a YouTube channel. |
| `PERMISSION_DENIED` when posting to an **external** stream | YouTube refused the message in that chat: members-only or subscribers-only chat, your account is banned or timed out there, or the channel restricts chat. The app cannot bypass this; the session stops. Your connection is not marked as broken. |
| `PERMISSION_DENIED` (`liveStreamingNotEnabled`) on Accounts → Check stream | Live streaming is not enabled on your own channel (needed only to check or stream on your channel, not to post in other streams). Enable it in YouTube Studio; activation can take up to 24 hours. |
| `NOT_LIVE` when starting, or session stops with `NOT_LIVE` | The selected stream is not **live**. It must actually be live (not just scheduled or in preview). The scheduler re-checks the selected video every tick and stops when the stream ends. |
| `CHAT_UNAVAILABLE` / `liveChatDisabled` / `liveChatEnded` | Live chat is turned off for the stream, the chat ended, or **this chat cannot be accessed by the connected account** (external streams: the read-only probe was refused). For your own stream, enable chat in YouTube Studio; then validate the stream again and start a new session. |
| `TERMS_ACCEPTANCE_REQUIRED` | Starting or resuming on an external livestream needs a current acceptance of the External Livestream Terms for this account and stream. The dashboard opens the terms; read to the end, tick the box and accept, or decline. |
| `TERMS_OUTDATED` | The terms changed while the modal was open. The modal reloads the new version; read it to the end and decide again. |
| `ACKNOWLEDGEMENT_REQUIRED` | You tried to connect a stream on another channel without ticking the owner's-permission acknowledgement. Tick it only if the stream owner agreed. |
| `INVALID_STREAM_URL` | The URL is not one of the accepted YouTube formats, or the video id is malformed. Copy the URL from the browser address bar or YouTube's **Share** button. |
| `STREAM_NOT_FOUND` | YouTube has no video with that id, or it is private and not visible to the connected account. Check the URL. |
| `STREAM_OFFLINE` | The selected stream is upcoming, has ended, or is not a livestream. Go live, then validate again. |
| `NO_STREAM_SELECTED` | Start was pressed without a selected stream. Use **Livestream Setup → Connect to Stream** first. |
| `STREAM_CONNECTION_MISMATCH` | (Legacy routes) the selection was validated with a different account than the default workflow's. Use the account's own workflow in the Scheduler view and validate there. |
| `SCHEDULER_ACTIVE` | You tried to change or clear an account's stream while its workflow is running or paused. Stop that workflow first. |
| `STREAM_IN_USE` | Another account's active (running or paused) workflow is already bound to this stream. Only one workflow may post to a stream; stop the other one, or choose a different stream. |
| `CONCURRENT_EXTERNAL_BLOCKED` | You started a workflow while another is active, and one of them targets an **external** stream. A workflow on someone else's stream must run alone. Stop the other workflow first. |
| Connect: "signed in with a different channel" / authorization rejected | On **Connect** (re-authorize) you picked a Google account whose channel is not this connection's channel. Nothing was changed. Connect again and pick the right account in Google's chooser; to add that other channel, use **Add YouTube Account** instead. |
| Refresh Status shows `AUTH_FAILED` | That account's refresh token expired (7 days in Testing mode) or was revoked at https://myaccount.google.com/permissions. Use **Connect** on it. Other accounts keep working. |
| Refresh Status shows `PERMISSION_DENIED` / "Missing required permission" | The `youtube.force-ssl` permission was not granted for this account. **Connect** and allow every permission. |
| Refresh Status shows `QUOTA_EXCEEDED` / `NETWORK` | The shared project quota is used up (wait for midnight Pacific Time), or YouTube could not be reached. The connection itself is not changed. |
| `NO_PENDING_REVIEW` / `TOO_SOON` / `SEND_IN_PROGRESS` | Manual review: nothing is waiting for approval (already approved/skipped or the session stopped), the minimum delay since the last send has not passed yet (wait and approve again), or a send is already running. |
| `QUOTA_EXCEEDED` (`quotaExceeded`) | Daily API quota of the Google Cloud project used up (shared by all accounts). It resets at midnight Pacific Time. Lower the posting frequency / set daily limits, run fewer workflows, or request more quota in Google Cloud. |
| `AUTH_FAILED` / "Token refresh failed" / `invalid_grant` | That account's refresh token expired (7 days in Testing mode), was revoked, or the password changed. Use **Connect** on that account. "Stored credentials could not be read (encryption key changed?)" means the key differs from the one used to store the tokens — restore the original key or reconnect. |
| `NOT_CONFIGURED` when connecting YouTube | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing in `.env`, or the app was not restarted. |
| AI `AUTH_FAILED` ("rejected the API key (HTTP 401)") | Wrong or revoked `AI_API_KEY`, or the key doesn't belong to `AI_BASE_URL`. |
| AI `RATE_LIMITED` (HTTP 429) | Provider rate limit or no credit left. Wait, or check billing. The app itself allows 10 generations per minute. |
| AI `TIMEOUT` / `NETWORK` | Endpoint unreachable or slow (local models: is Ollama/LM Studio running and the model loaded?). Raise `AI_TIMEOUT_MS` for slow local models. |
| `ExperimentalWarning: SQLite is an experimental feature` | Printed by some Node 22.x versions for `node:sqlite`. Harmless; Node 24 LTS does not show it. |
| `SyntaxError`/`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` or `No such built-in module` | Node is too old. Install Node 22.13+ (`winget install OpenJS.NodeJS.LTS`), reopen PowerShell, check `node --version`. |
| `403 BAD_HOST` | You opened the app via a different host name/IP (e.g. your LAN IP). Use `http://127.0.0.1:<PORT>`. |
| `403 BAD_CSRF` / `BAD_ORIGIN` | The page is stale after a server restart (new CSRF token) — reload; or a request came from another origin. |
| `429 RATE_LIMITED` | Too many requests in a minute; wait a moment. |

## Verification status

**Covered by automated tests (`npm test`, all with mocks, no network):**

- Unit tests for every service and provider: message rules and duplicates, import formats, activity redaction, drafts pipeline, OpenAI-compatible request/response/error mapping, Google OAuth (state, PKCE, exchange, refresh, revoke) against a mocked `fetch`, YouTube provider request shapes and error mapping against a mocked `fetch`, token encryption, scheduler timing/limits/overlap/failure handling with a fake clock, livestream URL parsing (all accepted formats, unrelated and malformed URLs), stream status mapping (live, upcoming, ended, not found, external-channel streams, chat disabled or not accessible, permission errors), the scheduler never replacing the selected stream with another active broadcast, the selected stream's chat id being the one passed to the sender, manual review approve/skip, no send counted without provider confirmation, and multi-account workflows (each workflow using only its own account's credentials and stream, independent start/stop and failure handling, per-account daily limits and audit entries, `STREAM_IN_USE` and `CONCURRENT_EXTERNAL_BLOCKED` enforcement, concurrent Start requests, disconnect/remove stopping only that account's workflow, re-authorization refusing a different channel).
- Integration tests (`test/integration/api.test.js`) of the full Express app: Host/Origin/CSRF rejection, security headers, path traversal and dotfiles, messages CRUD/duplicates/validation/search/filters, import (all formats) and export (no ids or secrets), load-samples, draft generate → approve → library, AI 401/429/500/network errors (correct JSON code, key never leaked), scheduler start → confirmed send counted only after provider confirmation → failed send not counted → pause/resume → stop, `NOT_LIVE` / `CHAT_UNAVAILABLE`, stream validate/select/clear, external-stream acknowledgement, and `SCHEDULER_ACTIVE` while running, logs filters and redacted JSON/CSV exports, cleanup confirmation and wipe, OAuth not-configured paths, JSON 404s, rate limiting.
- Script logic (`test/integration/scripts.test.js`): import file validation, online backup of a live WAL database, backup validation, restore with pre-restore copy, server-running detection.

**NOT verified automatically (requires real accounts and must be checked by hand):**

- Real Google OAuth consent, token exchange, refresh and revocation, including the account chooser with several Google accounts in one browser profile.
- Migration 005 on a real database from the previous version (the migration is covered by tests on generated databases).
- Real `liveBroadcasts.list` / `liveChatMessages.insert` calls and that messages appear in your chat.
- Posting to a real external stream: which chat restrictions YouTube reports for which error reason (members-only, subscribers-only, bans, slow mode).
- That the read-only `liveChatMessages.list` probe is refused for chats your account cannot access, and its real quota cost.
- That `videos.list` omits `liveStreamingDetails.activeLiveChatId` when chat is disabled (the documented behaviour; if it does not, a disabled chat still surfaces as `CHAT_UNAVAILABLE` on the first send and stops the session).
- Real quota consumption and Google error responses.
- A real AI endpoint (OpenAI / Ollama / LM Studio) and the quality of its output.

### Manual verification checklist

1. `npm test` passes; `npm start` → `http://127.0.0.1:3000` loads, Test Mode banner shown.
2. In Test Mode: load samples, add a Test Mode connection, start a session with a 30 s interval; confirm `message.sent` entries with `test-` ids, pause/resume/stop work, daily limit stops the session.
3. Complete [Google Cloud OAuth setup](#google-cloud-oauth-setup), set `CHAT_PROVIDER=youtube`, restart, connect your channel; the connection shows your channel name and status `connected`.
4. While **not** live: "Check" shows no active livestream; Start without a selected stream fails with `NO_STREAM_SELECTED`; validating a scheduled stream's URL shows **Valid** (Connect allowed; Start fails with `NOT_LIVE` until it is live), and an ended one shows **Offline** (Connect refused).
5. Go live (an unlisted test stream is fine). "Check" shows the broadcast and chat available. Paste your stream's URL in **Livestream Setup** → **Validate Stream** shows **Live** with your title and channel → **Connect to Stream**.
6. Paste the URL of a live stream on **another** channel (whose owner agreed) → Validate shows **Live**, the channel name, and posting permission **unverified**; Connect is refused until you tick the acknowledgement. Enable **Manual review**, start, and approve one message; confirm it appears in that chat from your account. Paste a non-YouTube URL → `INVALID_STREAM_URL`.
7. While a session runs, confirm the stream controls are disabled and the selected stream is shown in the Scheduler and Overview.
8. Start with a long interval (e.g. 120 s) and a small session limit (e.g. 2). Confirm each message appears in your live chat **from your channel**, and the log shows `message.sent` with a real message id only after it appears.
9. End the stream: the session stops with `NOT_LIVE` on the next tick (it does not move to another broadcast).
10. Disconnect: the connection shows `disconnected`, and the app no longer appears (or shows as removed) at https://myaccount.google.com/permissions.
11. With an AI key: generate drafts, approve one, confirm it appears in the library; with a wrong key, confirm a clear `AUTH_FAILED` error and that the key does not appear in the UI or exported logs.
12. `npm run backup`, stop the app, `npm run restore -- <file> --yes`, start again; data is intact and the connection still works with the same key.
13. Multiple accounts: add a second test-user account with **Add YouTube Account**; both appear in Accounts with their own channel names. **Refresh Status** on each shows `connected`. Use **Connect** on account A but pick account B in Google's chooser: it is rejected and A is unchanged.
14. With both accounts live on their **own** streams, start both workflows; each posts only to its own stream (check the channel name on each message). Selecting the same stream for both and starting the second gives `STREAM_IN_USE`; an external stream on either gives `CONCURRENT_EXTERNAL_BLOCKED` while the other runs.
15. Disconnect account B while both run: only B's workflow stops; A keeps posting. Activity Logs filtered by account show each account's own entries.

## Project structure

```
src/
  server.js            entry point; binds HOST:PORT (127.0.0.1:3000)
  app.js               Express app: host/CSRF guards, headers, rate limits, routes, static files, errors
  context.js           composition root (dependency injection)
  config.js            .env → config object; categories; 200-char limit
  errors.js logger.js  error types; console logger + redaction
  db/                  node:sqlite connection, migrations (001_init.sql, 002_send_ledger.sql, 003_stream_selection.sql, 004_external_review.sql, 005_multi_account.sql, 006_terms_acknowledgements.sql)
  legal/               externalStreamTerms.js (versioned DRAFT terms text; needs legal review)
  security/            crypto.js (AES-256-GCM), origin.js (Host/Origin/CSRF), rateLimit.js
  lib/                 text rules, HTTP helpers, central error handler, youtubeUrl.js (stream URL parsing)
  providers/chat/      youtubeProvider.js (pluggable YouTube Data API v3 provider), testProvider.js (dry run)
  providers/ai/        openaiCompatible.js, presetProvider.js + presetLibrary.js
  services/            activity, messages, drafts, connections, googleOAuth, scheduler (one engine per workflow),
                       schedulerManager (per-account workflows, cross-workflow rules), streamSelection (selected livestream),
                       terms (External Livestream Terms decisions)
  routes/              /api/* routers and /oauth/google/callback (workflows.js = /api/workflows, stream.js = legacy /api/stream)
  validation/          zod schemas per area (workflows.js, stream.js)
public/                dashboard (no build step; ES modules, CSP-safe)
samples/               messages.sample.json
scripts/               import-messages.js, backup.js, restore.js, lib/
test/                  helpers.js, unit/, integration/ (node:test), e2e/ (Playwright)
docs/ARCHITECTURE.md   module contracts and HTTP API reference
```
