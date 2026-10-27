export interface PublicPort {
  id: string;
  machineId: string;
  port: number;
  name: string;
  url: string;
  createdAt: string;
}

export interface PublicPortOverview { enabled: boolean; ports: PublicPort[] }
export const maxPublicPorts = 16;

export function portInputError(port: unknown, name: unknown): string {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535)
    return '端口号需要是 1024 到 65535 的整数。';
  if (port === 5901 || port === 6768) return '5901 和 6768 是平台保留端口，不能公开。';
  if (typeof name !== 'string' || Array.from(name).length > 100 || /[\u0000-\u001f\u007f]/.test(name))
    return '端口名称最多 100 个字符，不能包含控制字符。';
  return '';
}

export function publicPortUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
