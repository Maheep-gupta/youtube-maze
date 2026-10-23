-- Livestreams on other channels and manual review.
-- target_external: the selected stream is hosted by a channel other than the connected one; selecting it
-- requires an explicit acknowledgement (target_acknowledged_at). Posting permission for such a chat is
-- never assumed: it is confirmed only when YouTube accepts a message.
-- review_mode: each proposed message waits for the user's approval before it is posted.
ALTER TABLE scheduler_settings ADD COLUMN target_external INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_settings ADD COLUMN target_acknowledged_at TEXT;
ALTER TABLE scheduler_settings ADD COLUMN review_mode INTEGER NOT NULL DEFAULT 0;
