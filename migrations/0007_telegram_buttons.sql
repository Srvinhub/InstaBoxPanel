CREATE TABLE IF NOT EXISTS insb_telegram_buttons (
  token TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  request_id TEXT NOT NULL,
  webhook_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_telegram_buttons_expiry ON insb_telegram_buttons(expires_at);
