import type { Session } from '../shared/types';
import { encryptKey, decryptKey } from './crypto';
import { PanelError } from './errors';
import { database, ensureDatabase, isMissingPanelTable } from './schema';
import { decode, derivePassword, digest, encode, equalHash, PASSWORD_ITERATIONS, validateCredentials } from './password';

export interface LoginEnv { DB: D1Database; KEY_ENCRYPTION_SECRET?: string }
export interface Identity { username: string; key: string; sessionHash?: string }
interface AdminRow {
  id: number; username: string; password_hash: string; password_salt: string; password_iterations: number;
  key_ciphertext: string; key_iv: string;
}
interface SessionRow {
  token_hash: string; username: string; key_ciphertext: string; key_iv: string; expires_at: number;
}
const COOKIE_NAME = '__Host-insb_session';
const SESSION_SECONDS = 12 * 60 * 60;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const anonymous = (setupRequired: boolean): Session => ({ username: '', authenticated: false, setupRequired, demo: false });
const view = (username: string): Session => ({ username, authenticated: true, setupRequired: false, demo: false });

async function admin(db: D1Database): Promise<AdminRow | null> {
  return db.prepare('SELECT * FROM insb_admin WHERE id = 1').first<AdminRow>();
}
export async function authenticateSession(request: Request, db: D1Database): Promise<Identity> {
  const cookie = (request.headers.get('Cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith(COOKIE_NAME + '='));
  const token = cookie?.slice(COOKIE_NAME.length + 1) || '';
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new PanelError(401, 'authentication_required', '请登录管理员账号。');
  const hash = await digest(token);
  let row: SessionRow | null;
  try {
    row = await db.prepare(`SELECT s.token_hash,s.key_ciphertext,s.key_iv,s.expires_at,a.username
      FROM insb_sessions AS s JOIN insb_admin AS a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).bind(hash, Date.now()).first<SessionRow>();
  } catch (error) {
    if (isMissingPanelTable(error)) throw new PanelError(401, 'authentication_required', '请先设置管理员账号。');
    throw error;
  }
  if (!row) throw new PanelError(401, 'authentication_required', '登录已过期，请重新登录。');
  const wrappingKey = encode(decode(token.replace(/-/g, '+').replace(/_/g, '/') + '='));
  const key = await decryptKey(row.key_ciphertext, row.key_iv, wrappingKey, 'session:' + hash);
  return { username: row.username, key, sessionHash: hash };
}
export async function sessionStatus(env: LoginEnv, request: Request): Promise<Session> {
  const db = database(env); await ensureDatabase(db);
  if (!await admin(db)) return anonymous(true);
  try { return view((await authenticateSession(request, db)).username); }
  catch (error) { if (error instanceof PanelError && error.code === 'authentication_required') return anonymous(false); throw error; }
}
async function rateLimit(db: D1Database, request: Request): Promise<void> {
  const timestamp = Date.now(), window = Math.floor(timestamp / RATE_WINDOW_MS), expires = (window + 1) * RATE_WINDOW_MS;
  const ip = await digest((request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128));
  const buckets = ['login:ip:' + ip + ':' + window, 'login:global:' + window];
  const results = await db.batch<{ attempts: number }>([
    ...buckets.map(bucket => db.prepare(`INSERT INTO insb_login_limits (bucket,attempts,expires_at) VALUES (?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(bucket, expires)),
    db.prepare('DELETE FROM insb_login_limits WHERE expires_at <= ?').bind(timestamp),
  ]);
  if (results[0].results[0].attempts > 30 || results[1].results[0].attempts > 200)
    throw new PanelError(429, 'login_rate_limited', '登录尝试过于频繁，请稍后再试。', true, Math.ceil((expires - timestamp) / 1000));
}
async function issueSession(db: D1Database, username: string, key: string) {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = encode(random).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), hash = await digest(token);
  const encrypted = await encryptKey(key, encode(random), 'session:' + hash);
  const timestamp = Date.now();
  await db.batch([
    db.prepare('DELETE FROM insb_sessions WHERE expires_at <= ?').bind(timestamp),
    db.prepare('INSERT INTO insb_sessions (token_hash,admin_id,key_ciphertext,key_iv,created_at,expires_at) VALUES (?,1,?,?,?,?)')
      .bind(hash, encrypted.ciphertext, encrypted.iv, timestamp, timestamp + SESSION_SECONDS * 1000),
  ]);
  return { session: view(username), cookie: `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}` };
}
export async function setupAdmin(env: LoginEnv, request: Request, body: unknown) {
  const db = database(env); await ensureDatabase(db);
  if (await admin(db)) throw new PanelError(409, 'already_initialized', '管理员已经设置，请直接登录。');
  const { username, password } = validateCredentials(body, true);
  await rateLimit(db, request);
  const existingKeys = await db.prepare("SELECT id,key_ciphertext,key_iv FROM insb_accounts WHERE key_ciphertext <> '' LIMIT 1").first<{id:string;key_ciphertext:string;key_iv:string}>();
  if (existingKeys && !env.KEY_ENCRYPTION_SECRET)
    throw new PanelError(503, 'legacy_encryption_key_required', '已有账号凭据需要原 KEY_ENCRYPTION_SECRET；请在首次设置时临时配置该密钥。');
  const key = env.KEY_ENCRYPTION_SECRET || encode(crypto.getRandomValues(new Uint8Array(32)));
  try { if (decode(key).length !== 32) throw new Error('invalid key length'); }
  catch { throw new PanelError(503, 'encryption_configuration', '原 KEY_ENCRYPTION_SECRET 必须为 32 字节随机数的 Base64 编码。'); }
  if (existingKeys) await decryptKey(existingKeys.key_ciphertext, existingKeys.key_iv, key, existingKeys.id);
  const salt = encode(crypto.getRandomValues(new Uint8Array(32))), derived = await derivePassword(password, salt);
  const encrypted = await encryptKey(key, derived.wrappingKey, 'admin:1');
  const timestamp = new Date().toISOString();
  const result = await db.prepare(`INSERT OR IGNORE INTO insb_admin
    (id,username,password_hash,password_salt,password_iterations,key_ciphertext,key_iv,created_at,updated_at)
    VALUES (1,?,?,?,?,?,?,?,?)`).bind(username, derived.hash, salt, PASSWORD_ITERATIONS, encrypted.ciphertext, encrypted.iv, timestamp, timestamp).run();
  if (!result.meta.changes) throw new PanelError(409, 'already_initialized', '管理员已经设置，请直接登录。');
  return issueSession(db, username, key);
}
export async function loginAdmin(env: LoginEnv, request: Request, body: unknown) {
  const db = database(env); await ensureDatabase(db);
  const row = await admin(db);
  if (!row) throw new PanelError(409, 'setup_required', '首次使用，请先设置管理员账号和密码。');
  await rateLimit(db, request);
  const { username, password } = validateCredentials(body);
  const derived = await derivePassword(password, row.password_salt, row.password_iterations);
  const validPassword = equalHash(row.password_hash, derived.hash);
  if (!validPassword || username !== row.username.toLowerCase()) throw new PanelError(401, 'invalid_credentials', '账号或密码不正确。');
  const key = await decryptKey(row.key_ciphertext, row.key_iv, derived.wrappingKey, 'admin:1');
  return issueSession(db, row.username, key);
}
export async function logoutAdmin(db: D1Database, request: Request): Promise<string> {
  try {
    const identity = await authenticateSession(request, db);
    await db.prepare('DELETE FROM insb_sessions WHERE token_hash = ?').bind(identity.sessionHash).run();
  } catch (error) { if (!(error instanceof PanelError && error.code === 'authentication_required')) throw error; }
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
