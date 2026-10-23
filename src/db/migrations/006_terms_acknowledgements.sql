-- Append-only record of External Livestream Terms decisions (accepted or declined). It holds only
-- what is needed to show which terms were confirmed for which account and stream: no passwords,
-- tokens, email addresses or message text. No foreign key to account_connections, so the history
-- survives removing an account; "Delete all local data" clears it.
CREATE TABLE terms_acknowledgements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  terms_id          TEXT    NOT NULL,                 -- e.g. external-stream
  terms_version     TEXT    NOT NULL,                 -- version shown to the user
  material_version  INTEGER NOT NULL,                 -- acknowledgements are valid only for the current one
  content_hash      TEXT    NOT NULL,                 -- SHA-256 of the terms text that was shown
  connection_id     TEXT    NOT NULL,                 -- local account id
  channel_id        TEXT,                             -- YouTube channel id of that account (public identifier)
  video_id          TEXT    NOT NULL,                 -- selected livestream
  status            TEXT    NOT NULL CHECK (status IN ('accepted', 'declined')),
  created_at        TEXT    NOT NULL                  -- UTC ISO-8601
);
CREATE INDEX idx_terms_ack_lookup ON terms_acknowledgements(terms_id, connection_id, video_id, id);
