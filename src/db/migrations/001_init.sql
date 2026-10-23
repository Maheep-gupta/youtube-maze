-- Initial schema. Timestamps are ISO-8601 UTC strings. Booleans are 0/1.
-- No passwords are ever stored. OAuth tokens are stored only AES-256-GCM encrypted.

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT    NOT NULL,
  normalized    TEXT    NOT NULL UNIQUE,          -- normalizeForCompare(text); enforces duplicate detection
  category      TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  source        TEXT    NOT NULL DEFAULT 'manual', -- manual | import | ai | preset
  times_sent    INTEGER NOT NULL DEFAULT 0,
  last_sent_at  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX idx_messages_category ON messages(category, enabled);

CREATE TABLE account_connections (
  id                TEXT PRIMARY KEY,               -- uuid
  provider          TEXT NOT NULL,                  -- youtube | test
  label             TEXT NOT NULL,                  -- non-sensitive display name (channel title)
  external_id       TEXT,                           -- channel id
  scopes            TEXT NOT NULL DEFAULT '[]',     -- JSON array of granted scopes
  status            TEXT NOT NULL DEFAULT 'connected', -- connected | disconnected | error
  encrypted_tokens  TEXT,                           -- crypto.encrypt(JSON tokens); NULL after disconnect
  token_expires_at  TEXT,
  last_used_at      TEXT,
  last_error        TEXT,                           -- sanitized
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (provider, external_id)
);

CREATE TABLE scheduler_settings (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  interval_seconds           INTEGER NOT NULL DEFAULT 120,
  min_delay_seconds          INTEGER NOT NULL DEFAULT 60,
  max_messages_per_session   INTEGER NOT NULL DEFAULT 30,
  daily_limit                INTEGER,               -- NULL = no daily limit
  categories                 TEXT    NOT NULL DEFAULT '[]', -- JSON array; empty = all categories
  max_consecutive_failures   INTEGER NOT NULL DEFAULT 3,
  connection_id              TEXT,                  -- account_connections.id used for sending
  updated_at                 TEXT    NOT NULL
);
INSERT INTO scheduler_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,                -- uuid
  connection_id    TEXT,
  provider         TEXT NOT NULL,
  broadcast_id     TEXT,
  live_chat_id     TEXT,
  broadcast_title  TEXT,
  status           TEXT NOT NULL,                   -- running | paused | stopped | error | completed
  messages_sent    INTEGER NOT NULL DEFAULT 0,
  messages_failed  INTEGER NOT NULL DEFAULT 0,
  last_message_id  INTEGER,
  stop_reason      TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT
);
CREATE INDEX idx_sessions_started ON sessions(started_at);

CREATE TABLE activity_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  event_type  TEXT NOT NULL,                        -- e.g. scheduler.start, message.sent, message.failed, connection.added
  level       TEXT NOT NULL,                        -- success | info | warning | error
  session_id  TEXT,
  provider    TEXT,
  category    TEXT,
  outcome     TEXT,
  message_id  INTEGER,
  details     TEXT                                  -- JSON, passed through redact()
);
CREATE INDEX idx_activity_ts ON activity_logs(ts);
CREATE INDEX idx_activity_level ON activity_logs(level, event_type);

CREATE TABLE generated_drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      TEXT NOT NULL,
  text          TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  category      TEXT NOT NULL,
  tone          TEXT,
  language      TEXT,
  provider      TEXT NOT NULL,                      -- openai-compatible | preset
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  duplicate_of  INTEGER,                            -- messages.id if it duplicates an existing message
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX idx_drafts_status ON generated_drafts(status, batch_id);
