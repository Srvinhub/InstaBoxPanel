import { encryptKey, decryptKey } from './crypto';
import { PanelError } from './errors';

export interface AutomationEnv { DB: D1Database; AUTOMATION_SECRET?: string }
export function hasAutomationSecret(env: AutomationEnv): boolean {
  try { return atob(env.AUTOMATION_SECRET || '').length === 32; } catch { return false; }
}
export function automationSecret(env: AutomationEnv): string {
  if (!hasAutomationSecret(env)) throw new PanelError(503, 'automation_configuration', '请先在 Cloudflare 后台配置 AUTOMATION_SECRET（32 字节随机数的 Base64 编码）。');
  return env.AUTOMATION_SECRET!;
}
export async function enableAutomation(env: AutomationEnv, dataKey: string) {
  const encrypted = await encryptKey(dataKey, automationSecret(env), 'automation:1');
  await env.DB.prepare('INSERT INTO insb_automation (id,key_ciphertext,key_iv) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET key_ciphertext=excluded.key_ciphertext,key_iv=excluded.key_iv')
    .bind(encrypted.ciphertext, encrypted.iv).run();
}
export async function automationDataKey(env: AutomationEnv): Promise<string> {
  const row = await env.DB.prepare('SELECT key_ciphertext,key_iv FROM insb_automation WHERE id=1').first<{ key_ciphertext: string; key_iv: string }>();
  if (!row) throw new PanelError(503, 'automation_not_enabled', '请登录面板并重新保存自动化设置。');
  return decryptKey(row.key_ciphertext, row.key_iv, automationSecret(env), 'automation:1');
}
