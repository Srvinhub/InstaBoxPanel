import { PanelError } from './errors';

// workerd's native PBKDF2 permits at most 100,000 iterations. Two SHA-256 output
// blocks independently protect password verification and the encrypted data key.
export const PASSWORD_ITERATIONS = 100000;
export function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
export function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
export async function derivePassword(password: string, salt: string, iterations = PASSWORD_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > PASSWORD_ITERATIONS || decode(salt).length !== 32)
    throw new PanelError(500, 'invalid_password_record', '登录配置无效，请检查数据库。');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: decode(salt), hash: 'SHA-256', iterations }, material, 512));
  return { hash: encode(bits.slice(0, 32)), wrappingKey: encode(bits.slice(32)) };
}
export function equalHash(a: string, b: string): boolean {
  const left = decode(a), right = decode(b);
  if (left.length !== 32 || right.length !== 32) return false;
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validateCredentials(body: unknown, setup = false): { username: string; password: string } {
  const value = body as { username?: unknown; password?: unknown } | null;
  if (!value || typeof value.username !== 'string' || !/^[a-zA-Z0-9_.@-]{3,64}$/.test(value.username.trim()) ||
      typeof value.password !== 'string' || value.password.length < (setup ? 12 : 1) || value.password.length > 128) {
    throw new PanelError(setup ? 400 : 401, setup ? 'invalid_credentials_format' : 'invalid_credentials',
      setup ? '账号需为 3 到 64 个字母、数字或 . _ @ -；密码需为 12 到 128 个字符。' : '账号或密码不正确。');
  }
  return { username: value.username.trim().toLowerCase(), password: value.password };
}
