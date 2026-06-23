CREATE TABLE IF NOT EXISTS healthspan (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,             -- UTC date (YYYY-MM-DD)
  fitness_age REAL,
  chronological_age INTEGER,
  pace_of_aging REAL,
  contributors TEXT,              -- JSON: { sleep: { score, impact }, strain: { ... }, fitness: { ... } }
  is_calibrating INTEGER DEFAULT 1, -- 0/1 (until 90 days)
  locked INTEGER DEFAULT 1,       -- 0/1 (until 5 recoveries in 7 days + age >= 18)
  updated_at INTEGER,
  PRIMARY KEY(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_healthspan_user_date ON healthspan(user_id, date);