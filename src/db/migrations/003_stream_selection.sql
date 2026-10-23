-- Explicit livestream selection. The scheduler is bound to this one video and never picks
-- another broadcast. target_connection_id is the connection that validated the selection.
ALTER TABLE scheduler_settings ADD COLUMN target_video_id TEXT;
ALTER TABLE scheduler_settings ADD COLUMN target_url TEXT;
ALTER TABLE scheduler_settings ADD COLUMN target_title TEXT;
ALTER TABLE scheduler_settings ADD COLUMN target_channel_title TEXT;
ALTER TABLE scheduler_settings ADD COLUMN target_connection_id TEXT;
ALTER TABLE scheduler_settings ADD COLUMN target_validated_at TEXT;

ALTER TABLE sessions ADD COLUMN video_id TEXT;
