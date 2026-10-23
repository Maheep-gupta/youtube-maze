-- Multiple independently authorized sender accounts. Each account connection gets its own workflow:
-- scheduler settings plus the ONE livestream it is bound to. A workflow only ever sends with its own
-- account to its own selected stream. scheduler_settings stays as the legacy "default workflow"
-- pointer (connection_id) and as the template for new workflows.
CREATE TABLE workflows (
  connection_id              TEXT PRIMARY KEY,         -- account_connections.id
  interval_seconds           INTEGER NOT NULL DEFAULT 120,
  min_delay_seconds          INTEGER NOT NULL DEFAULT 60,
  max_messages_per_session   INTEGER NOT NULL DEFAULT 30,
  daily_limit                INTEGER,                  -- NULL = no daily limit
  categories                 TEXT    NOT NULL DEFAULT '[]',
  max_consecutive_failures   INTEGER NOT NULL DEFAULT 3,
  review_mode                INTEGER NOT NULL DEFAULT 0,
  target_video_id            TEXT,
  target_url                 TEXT,
  target_title               TEXT,
  target_channel_title       TEXT,
  target_external            INTEGER NOT NULL DEFAULT 0,
  target_acknowledged_at     TEXT,
  target_validated_at        TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

-- Carry the existing single-account settings (and its stream selection, if it was validated with
-- that same account) over to that account's workflow.
INSERT INTO workflows (connection_id, interval_seconds, min_delay_seconds, max_messages_per_session, daily_limit, categories,
  max_consecutive_failures, review_mode, target_video_id, target_url, target_title, target_channel_title, target_external,
  target_acknowledged_at, target_validated_at, created_at, updated_at)
SELECT s.connection_id, s.interval_seconds, s.min_delay_seconds, s.max_messages_per_session, s.daily_limit, s.categories,
  s.max_consecutive_failures, s.review_mode,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_video_id END,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_url END,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_title END,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_channel_title END,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_external ELSE 0 END,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_acknowledged_at END,
  CASE WHEN s.target_connection_id = s.connection_id THEN s.target_validated_at END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM scheduler_settings s
WHERE s.id = 1 AND s.connection_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM account_connections c WHERE c.id = s.connection_id);

-- Per-account audit trail and per-account daily limits.
ALTER TABLE activity_logs ADD COLUMN connection_id TEXT;
CREATE INDEX idx_activity_connection ON activity_logs(connection_id, id);
UPDATE activity_logs SET connection_id = (SELECT connection_id FROM sessions WHERE sessions.id = activity_logs.session_id)
  WHERE session_id IS NOT NULL;

ALTER TABLE send_ledger ADD COLUMN connection_id TEXT;
UPDATE send_ledger SET connection_id = (SELECT connection_id FROM sessions WHERE sessions.id = send_ledger.session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_send_ledger_connection ON send_ledger(connection_id, ts);
