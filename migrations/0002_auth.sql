CREATE TABLE IF NOT EXISTS insb_admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations BETWEEN 10000 AND 100000),
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insb_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES insb_admin(id) ON DELETE RESTRICT,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_sessions_expires ON insb_sessions(expires_at);
CREATE TABLE IF NOT EXISTS insb_login_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_login_limits_expires ON insb_login_limits(expires_at);
