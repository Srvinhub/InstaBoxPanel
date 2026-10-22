import initialSql from '../../migrations/0001_initial.sql';
import authSql from '../../migrations/0002_auth.sql';
import { PanelError } from './errors';

const migrations = [
  { name: '0001_initial.sql', sql: initialSql },
  { name: '0002_auth.sql', sql: authSql },
];
const initialization = new WeakMap<object, Promise<void>>();

export function database(env: { DB?: D1Database }): D1Database {
  if (!env.DB || typeof env.DB.prepare !== 'function')
    throw new PanelError(503, 'database_configuration', '请在 Cloudflare 配置页面将 D1 数据库绑定为 DB，然后重试。');
  return env.DB;
}

export function isMissingPanelTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (/\bno such table:\s*(?:main\.)?insb_[a-z0-9_]+\b/i.test(String(current))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function initialize(db: D1Database): Promise<void> {
  // D1 batch is transactional; every statement also tolerates simultaneous first visits.
  const statements = [db.prepare(`CREATE TABLE IF NOT EXISTS insb_d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`)];
  for (const migration of migrations) {
    for (const statement of migration.sql.split(';').map(value => value.trim()).filter(Boolean)) {
      if (!/^PRAGMA foreign_keys\b/i.test(statement)) statements.push(db.prepare(statement));
    }
    statements.push(db.prepare('INSERT OR IGNORE INTO insb_d1_migrations (name) VALUES (?)').bind(migration.name));
  }
  await db.batch(statements);
}

export async function ensureDatabase(db: D1Database): Promise<void> {
  try {
    // Probe each required table, including partial initialization, without scanning rows.
    await db.prepare(`SELECT
      (SELECT id FROM insb_admin WHERE id = 1) AS admin_id,
      (SELECT id FROM insb_accounts LIMIT 1) AS account_id,
      (SELECT id FROM insb_actions LIMIT 1) AS action_id,
      (SELECT token_hash FROM insb_sessions LIMIT 1) AS session_id,
      (SELECT bucket FROM insb_login_limits LIMIT 1) AS rate_id,
      (SELECT name FROM insb_d1_migrations LIMIT 1) AS migration`).first();
  } catch (error) {
    if (!isMissingPanelTable(error)) throw error;
    let pending = initialization.get(db);
    if (!pending) {
      pending = initialize(db);
      initialization.set(db, pending);
    }
    try { await pending; }
    finally { if (initialization.get(db) === pending) initialization.delete(db); }
  }
}
