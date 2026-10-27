import type { Hono, Context } from 'hono';
import type { Env } from './app';
import type { Identity } from './session';
import type { AccountRow } from './db';
import type { Instabox, Fetcher } from './instabox';
import { PanelError } from './errors';
export type ResourceEnv = { Bindings: Env; Variables: { identity: Identity } };
export type ResourceApp = Hono<ResourceEnv>;
export type ResourceContext = Context<ResourceEnv>;
export interface ResourceAccess {
  account(db: D1Database, id: string, allowDisabled?: boolean): Promise<AccountRow>;
  remote(identity: Identity, row: AccountRow): Promise<Instabox>;
  fetcher?: Fetcher;
}
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new PanelError(400, 'invalid_id', '资源标识无效。');
  return value;
}
export async function resourceBody(c: ResourceContext): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PanelError(400, 'invalid_json', '请求 JSON 无效。');
  return body;
}
