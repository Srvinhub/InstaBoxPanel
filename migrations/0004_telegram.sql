CREATE TABLE IF NOT EXISTS insb_telegram (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  webhook_hash TEXT NOT NULL,
  notify_offline INTEGER NOT NULL DEFAULT 0 CHECK (notify_offline IN (0,1)),
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insb_telegram_updates (
  update_id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_telegram_updates_expiry ON insb_telegram_updates(expires_at);
CREATE TABLE IF NOT EXISTS insb_machine_watch (
  machine_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES insb_accounts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  pending_text TEXT
);
CREATE INDEX IF NOT EXISTS insb_machine_watch_account ON insb_machine_watch(account_id);
