-- Append-only record of provider-confirmed sends. The daily limit is counted from here so that
-- clearing activity logs cannot reset it. Only a full "delete all local data" cleanup removes it.
CREATE TABLE send_ledger (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   TEXT NOT NULL,
  session_id           TEXT,
  provider             TEXT NOT NULL,
  provider_message_id  TEXT NOT NULL,
  message_id           INTEGER
);
CREATE INDEX idx_send_ledger_ts ON send_ledger(ts);

-- Carry over sends already recorded in the activity log.
INSERT INTO send_ledger (ts, session_id, provider, provider_message_id, message_id)
  SELECT ts, session_id, COALESCE(provider, 'unknown'), COALESCE(json_extract(details, '$.providerMessageId'), 'unknown'), message_id
  FROM activity_logs WHERE event_type = 'message.sent';
