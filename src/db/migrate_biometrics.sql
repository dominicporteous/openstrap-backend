-- Add HRV + relative skin-temp/SpO₂ columns (run once on the live D1).
-- SQLite has no ADD COLUMN IF NOT EXISTS; re-running errors harmlessly on dupes.
ALTER TABLE daily ADD COLUMN hrv_rmssd REAL;
ALTER TABLE daily ADD COLUMN hrv_conf REAL;
ALTER TABLE daily ADD COLUMN skin_temp_idx REAL;
ALTER TABLE daily ADD COLUMN spo2_idx REAL;
ALTER TABLE baselines ADD COLUMN hrv_rmssd REAL;
ALTER TABLE baselines ADD COLUMN skin_temp_raw REAL;
ALTER TABLE baselines ADD COLUMN spo2_raw REAL;
