import { encryptKey, decryptKey } from './crypto';
import { PanelError } from './errors';
import { encode } from './password';
import { database, ensureDatabase } from './schema';

export interface AutomationEnv { DB: D1Database; AUTOMATION_SECRET?: string }
interface EncryptedRow { key_ciphertext: string; key_iv: string }
const databasePrefix = 'd1:';
function validKey(value: string | undefined): boolean {
  try { return atob(value || '').length === 32; } catch { return false; }
}
function legacySecret(env: AutomationEnv): string {
  if (!validKey(env.AUTOMATION_SECRET)) throw new PanelError(503, 'legacy_automation_credentials', '旧版后台凭据需要迁移，请登录面板重新保存保活设置；机器人请重新填写原 Token。');
  return env.AUTOMATION_SECRET!;
}
export function isDatabaseCredential(ciphertext: string): boolean { return ciphertext.startsWith(databasePrefix); }
async function databaseKey(env: AutomationEnv, create = false): Promise<string> {
  const db = database(env);
  let row = await db.prepare('SELECT wrapping_key FROM insb_automation_keys WHERE id=1').first<{ wrapping_key: string }>();
  if (!row && create) {
    await db.prepare('INSERT OR IGNORE INTO insb_automation_keys (id,wrapping_key) VALUES (1,?)')
      .bind(encode(crypto.getRandomValues(new Uint8Array(32)))).run();
    row = await db.prepare('SELECT wrapping_key FROM insb_automation_keys WHERE id=1').first<{ wrapping_key: string }>();
  }
  if (!row) throw new PanelError(503, 'automation_key_missing', '后台密钥已丢失，请登录面板重新保存保活设置；机器人需重新填写原 Token。');
  if (!validKey(row.wrapping_key)) throw new PanelError(503, 'automation_key_invalid', '数据库中的后台密钥无效，请恢复数据库备份。');
  return row.wrapping_key;
}
export async function encryptAutomation(env: AutomationEnv, value: string, context: string) {
  const encrypted = await encryptKey(value, await databaseKey(env, true), context);
  return { ciphertext: databasePrefix + encrypted.ciphertext, iv: encrypted.iv };
}
export async function decryptAutomation(env: AutomationEnv, ciphertext: string, iv: string, context: string): Promise<string> {
  return isDatabaseCredential(ciphertext)
    ? decryptKey(ciphertext.slice(databasePrefix.length), iv, await databaseKey(env), context)
    : decryptKey(ciphertext, iv, legacySecret(env), context);
}
export async function enableAutomation(env: AutomationEnv, dataKey: string) {
  const db = database(env);
  await ensureDatabase(db);
  if (!validKey(dataKey)) throw new PanelError(503, 'automation_data_key_invalid', '后台数据密钥无效，请重新登录。');
  const encrypted = await encryptAutomation(env, dataKey, 'automation:1');
  const statement = db.prepare('INSERT INTO insb_automation (id,key_ciphertext,key_iv) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET key_ciphertext=excluded.key_ciphertext,key_iv=excluded.key_iv')
    .bind(encrypted.ciphertext, encrypted.iv);
  const bot = await db.prepare('SELECT token_ciphertext,token_iv FROM insb_telegram WHERE id=1').first<{ token_ciphertext: string; token_iv: string }>();
  let oldToken: string | undefined;
  if (bot && !isDatabaseCredential(bot.token_ciphertext) && validKey(env.AUTOMATION_SECRET)) {
    try { oldToken = await decryptAutomation(env, bot.token_ciphertext, bot.token_iv, 'telegram:1'); }
    catch (error) { if (!(error instanceof PanelError && error.code === 'credential_decryption')) throw error; }
  }
  if (bot && oldToken) {
    const converted = await encryptAutomation(env, oldToken, 'telegram:1');
    await db.batch([statement,
      db.prepare("UPDATE insb_telegram SET token_ciphertext=?,token_iv=?,last_error='' WHERE id=1 AND token_ciphertext=? AND token_iv=?")
        .bind(converted.ciphertext, converted.iv, bot.token_ciphertext, bot.token_iv),
    ]);
  } else await statement.run();
}
export async function migrateAutomation(env: AutomationEnv, dataKey: string): Promise<void> {
  const row = await env.DB.prepare('SELECT key_ciphertext FROM insb_automation WHERE id=1').first<{ key_ciphertext: string }>();
  if (row && !isDatabaseCredential(row.key_ciphertext)) await enableAutomation(env, dataKey);
}
export async function automationDataKey(env: AutomationEnv): Promise<string> {
  const row = await env.DB.prepare('SELECT key_ciphertext,key_iv FROM insb_automation WHERE id=1').first<EncryptedRow>();
  if (!row) throw new PanelError(503, 'automation_not_enabled', '请登录面板并重新保存自动化设置。');
  const dataKey = await decryptAutomation(env, row.key_ciphertext, row.key_iv, 'automation:1');
  if (!validKey(dataKey)) throw new PanelError(503, 'automation_data_key_invalid', '后台数据密钥无效，请登录面板重新保存自动化设置。');
  if (!isDatabaseCredential(row.key_ciphertext)) await enableAutomation(env, dataKey);
  return dataKey;
}
