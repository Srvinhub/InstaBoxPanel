import { PanelError } from './errors';
function decode(value: string): Uint8Array<ArrayBuffer> {
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { throw new PanelError(503, 'encryption_configuration', '凭据加密密钥配置无效。'); }
}
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
async function key(secret: string) {
  const bytes = decode(secret || '');
  if (bytes.length !== 32) throw new PanelError(503, 'encryption_configuration', '凭据加密密钥无效，请检查登录配置或重新登录。');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptKey(value: string, secret: string, accountId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(accountId + ':v1'),
  }, await key(secret), new TextEncoder().encode(value));
  return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv) };
}
export async function decryptKey(ciphertext: string, iv: string, secret: string, accountId: string) {
  const cryptoKey = await key(secret);
  try {
    const plain = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: decode(iv), additionalData: new TextEncoder().encode(accountId + ':v1'),
    }, cryptoKey, decode(ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    throw new PanelError(503, 'credential_decryption', '无法解密账号凭据，请检查加密密钥或替换该账号的 API Key。');
  }
}
