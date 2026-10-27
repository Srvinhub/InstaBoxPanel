import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApp, type Env } from '../src/worker/app';
import type { Fetcher } from '../src/worker/instabox';

const origin = 'https://panel.test';
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Panel-Request': '1' };

test('public port management protects accounts and forwards only validated platform operations', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-19', d1Databases: ['DB'] }));
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const libraries = new Map<string, Map<number, any>>();
  const calls: { path: string; method: string; body: any; key: string }[] = [];
  let cookie = '', enabled = true, losePublish = false, loseDelete = false, mode = '', sequence = 0;
  const machine = (id: string) => ({ id, name: id, state: 'suspended', orgId: 'org_test', spec: { vcpus: 2, memMiB: 4096 }, runtime: { ready: false } });
  const fetcher: Fetcher = async (input, init = {}) => {
    const url = new URL(String(input)), h = new Headers(init.headers), key = h.get('X-API-Key') || '', method = init.method || 'GET';
    assert.equal(url.origin, 'https://api.instabox.sh'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    assert.equal(h.has('Cookie') || h.has('Origin') || h.has('Cf-Access-Jwt-Assertion'), false);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method, key, body });
    const suffix = key.endsWith('_b') ? 'b' : 'a';
    if (url.pathname === '/v1/me') return Response.json({ userId: suffix, login: suffix });
    if (url.pathname === '/v1/machines') return Response.json({ machines: [machine('m_' + suffix)], nextCursor: null });
    const match = url.pathname.match(/^\/v1\/machines\/(m_[ab])\/ports(?:\/(\d+))?$/);
    assert.ok(match, 'only public-port endpoints may be used');
    if (match[1] !== 'm_' + suffix) return Response.json({ error: { code: 'not_found', message: key } }, { status: 404 });
    if (mode === 'scope') return Response.json({ error: { code: 'insufficient_scope', message: key } }, { status: 403 });
    if (mode === 'limit') return Response.json({ error: { code: 'quota_exceeded', message: key } }, { status: 429 });
    if (mode === 'unavailable') return Response.json({ error: { code: 'unavailable', message: key } }, { status: 503 });
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
    if (!libraries.has(key)) libraries.set(key, new Map());
    const ports = libraries.get(key)!;
    if (method === 'GET') {
      const list = [...ports.values()].map(p => ({ ...p, privateKey: key }));
      if (mode === 'cross-machine' && list[0]) list[0].machineId = 'm_other';
      if (mode === 'unsafe-url' && list[0]) list[0].url = 'javascript:alert(1)';
      if (mode === 'duplicate' && list[0]) list.push(list[0]);
      return Response.json({ enabled, ports: mode === 'malformed' ? null : list });
    }
    if (method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['name', 'port']);
      const port = ports.get(body.port) || { id: 'public_' + ++sequence, machineId: match[1], port: body.port, url: 'https://port-' + sequence + '.example.test', createdAt: new Date().toISOString() };
      port.name = body.name; ports.set(port.port, port);
      if (losePublish) { losePublish = false; throw new Error('response lost ' + key); }
      return Response.json(port, { status: 201 });
    }
    assert.equal(method, 'DELETE'); assert.ok(match[2]); assert.equal(body, undefined);
    ports.delete(Number(match[2]));
    if (loseDelete) { loseDelete = false; throw new Error('response lost ' + key); }
    return new Response(null, { status: 204 });
  };
  const app = createApp({ fetcher }), env = { DB: db } as Env;
  async function call(path: string, method = 'GET', body?: unknown, cookieValue = cookie, extraHeaders = {}) {
    const response = await app.fetch(new Request(origin + path, { method, headers: { ...headers, ...extraHeaders, ...(cookieValue ? { Cookie: cookieValue } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, body: await response.json() as any };
  }
  try {
    const setup = await app.fetch(new Request(origin + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ username: 'ports-admin', password: 'ports-test-password' }) }), env);
    assert.equal(setup.status, 201); cookie = setup.headers.get('Set-Cookie')!.split(';')[0];
    const a = (await call('/api/accounts', 'POST', { label: 'A', apiKey: 'ibk_ports_a' })).body.account;
    const b = (await call('/api/accounts', 'POST', { label: 'B', apiKey: 'ibk_ports_b' })).body.account;
    const base = '/api/accounts/' + a.id + '/machines/m_a/ports';
    await t.test('anonymous and cross-origin requests never contact the platform', async () => {
      const start = calls.length;
      for (const [path, method, body] of [[base, 'GET', undefined], [base, 'POST', { port: 3000, name: 'preview' }], [base + '/3000', 'DELETE', { confirmPort: 3000, portId: 'public_1' }]] as const)
        assert.equal((await call(path, method, body, '')).status, 401);
      assert.equal((await call(base, 'POST', { port: 3000, name: 'preview' }, cookie, { Origin: 'https://evil.test' })).status, 403);
      assert.equal((await call(base + '/3000', 'DELETE', {}, cookie, { 'X-Panel-Request': '' })).status, 403);
      assert.equal(calls.length, start);
    });
    await t.test('lists paused machines without waking them and keeps accounts isolated', async () => {
      assert.deepEqual((await call(base)).body, { enabled: true, ports: [] });
      const other = '/api/accounts/' + b.id + '/machines/m_a/ports';
      assert.equal((await call(other)).status, 404);
      assert.equal((await call(other, 'POST', { port: 3000, name: 'other' })).status, 404);
      assert.equal(calls.at(-1)!.key, 'ibk_ports_b');
    });
    await t.test('rejects invalid ports, reserved ports, malformed bodies and names before sending a mutation', async () => {
      const start = calls.length;
      for (const port of [0, 80, 1023, 65536, 5901, 6768, 3000.5, '3000', null, true])
        assert.equal((await call(base, 'POST', { port, name: 'preview' })).status, 400);
      for (const name of [1, null, 'x'.repeat(101), 'a\nb']) assert.equal((await call(base, 'POST', { port: 3000, name })).status, 400);
      for (const body of [[], null, {}, 'invalid']) assert.equal((await call(base, 'POST', body)).status, 400);
      assert.equal((await call(base + '/3000', 'DELETE', { confirmPort: 3001, portId: 'public_1' })).status, 400);
      assert.equal((await call(base + '/3e3', 'DELETE', {})).status, 400);
      assert.equal(calls.length, start);
    });
    await t.test('publish and rename retain the URL and send only the intended fields', async () => {
      const first = await call(base, 'POST', { port: 3000, name: '开发预览', apiKey: 'must-not-forward', url: 'https://evil.test' });
      assert.equal(first.status, 200); assert.equal(first.body.port.name, '开发预览');
      const renamed = await call(base, 'POST', { port: 3000, name: '<img src=x onerror=alert(1)>' });
      assert.equal(renamed.body.port.url, first.body.port.url);
      const list = await call(base); assert.equal(list.body.ports.length, 1);
      assert.equal(JSON.stringify(list).includes('privateKey'), false); assert.equal(JSON.stringify(list).includes('ibk_ports_a'), false);
      for (const port of [1024, 65535]) assert.equal((await call(base, 'POST', { port, name: 'boundary' })).status, 200);
      assert.deepEqual((await call(base)).body.ports.map((p: any) => p.port), [1024, 3000, 65535]);
    });
    await t.test('malformed, mismatched and duplicate upstream results are rejected; unsafe links are removed', async () => {
      for (mode of ['malformed', 'cross-machine', 'duplicate', 'redirect']) assert.equal((await call(base)).status, 502);
      mode = 'unsafe-url'; assert.equal((await call(base)).body.ports.find((p: any) => p.port === 3000).url, ''); mode = '';
    });
    await t.test('lost publish responses can be reconciled by reading and do not cause automatic repeated writes', async () => {
      losePublish = true; const count = calls.filter(c => c.method === 'POST' && c.path.endsWith('/ports')).length;
      assert.equal((await call(base, 'POST', { port: 8080, name: 'lost response' })).status, 502);
      assert.equal(calls.filter(c => c.method === 'POST' && c.path.endsWith('/ports')).length, count + 1);
      const port = (await call(base)).body.ports.find((p: any) => p.port === 8080);
      assert.ok(port); const retry = await call(base, 'POST', { port: 8080, name: 'lost response' });
      assert.equal(retry.body.port.id, port.id); assert.equal(retry.body.port.url, port.url);
    });
    await t.test('confirmed unpublishing supports 204, checks stale mappings and reconciles lost delete responses', async () => {
      const port = (await call(base)).body.ports.find((p: any) => p.port === 3000);
      let deletes = calls.filter(c => c.method === 'DELETE').length;
      assert.equal((await call(base + '/3000', 'DELETE', { confirmPort: 3000, portId: 'old_mapping' })).status, 409);
      assert.equal(calls.filter(c => c.method === 'DELETE').length, deletes);
      loseDelete = true;
      assert.equal((await call(base + '/3000', 'DELETE', { confirmPort: 3000, portId: port.id })).status, 502);
      assert.equal((await call(base)).body.ports.some((p: any) => p.port === 3000), false);
      deletes = calls.filter(c => c.method === 'DELETE').length;
      assert.equal((await call(base + '/3000', 'DELETE', { confirmPort: 3000, portId: port.id })).status, 200);
      assert.equal(calls.filter(c => c.method === 'DELETE').length, deletes);
      const next = (await call(base)).body.ports[0];
      assert.equal((await call(base + '/' + next.port, 'DELETE', { confirmPort: next.port, portId: next.id })).status, 200);
    });
    await t.test('availability, quota and scope failures are safe and actionable', async () => {
      enabled = false; assert.equal((await call(base)).body.enabled, false); enabled = true;
      for (const [failure, status, text] of [['scope', 422, 'machines:write'], ['limit', 429, '16'], ['unavailable', 503, '暂不可用']] as const) {
        mode = failure; const result = await call(base, 'POST', { port: 8081, name: 'preview' });
        assert.equal(result.status, status); assert.ok(result.body.error.message.includes(text)); assert.equal(JSON.stringify(result).includes('ibk_ports_a'), false);
      }
      mode = '';
    });
    await t.test('disabled accounts cannot read or change forwarding', async () => {
      assert.equal((await call('/api/accounts/' + a.id, 'PATCH', { enabled: false })).status, 200);
      const before = calls.length;
      assert.equal((await call(base)).status, 409);
      assert.equal((await call(base, 'POST', { port: 3000, name: 'preview' })).status, 409);
      assert.equal(calls.length, before);
    });
  } finally { await mf.dispose(); }
});
