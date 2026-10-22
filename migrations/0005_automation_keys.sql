CREATE TABLE IF NOT EXISTS insb_automation_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  wrapping_key TEXT NOT NULL
);
