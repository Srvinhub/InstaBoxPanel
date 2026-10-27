CREATE TABLE IF NOT EXISTS insb_snapshot_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES insb_accounts(id),
  machine_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('create','delete')),
  snapshot_id TEXT,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('submitting','pending','succeeded','failed','unknown')),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_snapshot_requests_account ON insb_snapshot_requests(account_id,created_at);
