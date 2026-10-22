CREATE TABLE IF NOT EXISTS insb_action_sources (
  action_id TEXT PRIMARY KEY REFERENCES insb_actions(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('web', 'telegram', 'keepalive'))
);
