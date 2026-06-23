-- Add battery and charging status to analytics_cursor for diagnostics
ALTER TABLE analytics_cursor ADD COLUMN battery_pct INTEGER;
ALTER TABLE analytics_cursor ADD COLUMN is_charging INTEGER; -- 0/1