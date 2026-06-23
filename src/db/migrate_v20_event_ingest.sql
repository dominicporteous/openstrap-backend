-- Add ingested_at to events to track ingest rate
ALTER TABLE events ADD COLUMN ingested_at INTEGER;