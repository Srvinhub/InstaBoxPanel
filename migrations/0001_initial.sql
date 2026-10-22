PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS insb_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  instabox_user_id TEXT NOT NULL,
  login TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version = 1),
  key_suffix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS insb_actions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES insb_accounts(id) ON DELETE RESTRICT,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('suspend', 'resume', 'start', 'stop')),
  state TEXT NOT NULL CHECK (state IN ('submitting', 'queued', 'running', 'succeeded', 'failed', 'unknown')),
  operation_id TEXT,
  phase TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  error_message TEXT,
  processes_preserved INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_actions_recent ON insb_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS insb_actions_account_machine ON insb_actions(account_id, machine_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS insb_accounts_active_user ON insb_accounts(instabox_user_id) WHERE deleted_at IS NULL;
