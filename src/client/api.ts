import type { ApiErrorBody } from '../shared/types';
export const isDemo = import.meta.env.DEV && import.meta.env.VITE_DEMO === 'true';
export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (isDemo) {
    const { demoRequest } = await import('./demo');
    return demoRequest(path, options) as Promise<T>;
  }
  const method = options.method || 'GET';
  let response: Response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Panel-Request': '1' } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal || AbortSignal.timeout(40000),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('network_error', '连接暂时中断，请检查网络后重试。');
  }
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json'))
    throw new ApiError('authentication_required', '登录已过期，请重新登录。', 401);
  const data = await response.json();
  if (!response.ok) {
    const body = data as ApiErrorBody;
    throw new ApiError(body.error?.code || 'request_failed', body.error?.message || '请求未完成，请稍后重试。', response.status);
  }
  return data as T;
}
export async function concurrent<T>(items: T[], task: (item: T) => Promise<void>, limit = 3) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (i < items.length) await task(items[i++]);
  }));
}
