CREATE TABLE IF NOT EXISTS insb_keepalive (
  machine_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES insb_accounts(id) ON DELETE RESTRICT,
  machine_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'always', 'windows')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  windows_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  action_id TEXT,
  last_checked_at INTEGER,
  last_state TEXT NOT NULL DEFAULT '',
  last_result TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_keepalive_account ON insb_keepalive(account_id);
CREATE INDEX IF NOT EXISTS insb_actions_pending_machine ON insb_actions(machine_id)
  WHERE state IN ('submitting', 'queued', 'running', 'unknown');
CREATE TABLE IF NOT EXISTS insb_scheduler (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_tick INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER
);
INSERT OR IGNORE INTO insb_scheduler (id) VALUES (1);
CREATE TABLE IF NOT EXISTS insb_automation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL
);
