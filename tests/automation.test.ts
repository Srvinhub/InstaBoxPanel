import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createApp, type Env } from '../src/worker/app';
import { ensureDatabase } from '../src/worker/schema';
import { encryptKey, decryptKey } from '../src/worker/crypto';
import { automationDataKey, enableAutomation } from '../src/worker/automation';
import { createAction } from '../src/worker/actions';
import { runAutomation } from '../src/worker/scheduler';
import { checkTelegramNotifications } from '../src/worker/telegram';
import { validateSchedule, inKeepaliveWindow } from '../src/shared/keepalive';
import type { Fetcher } from '../src/worker/instabox';
import type { Machine } from '../src/shared/types';

const base = 'https://panel.test';
const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Panel-Request': '1' };
const dataKey = Buffer.alloc(32, 17).toString('base64');
const automationSecret = Buffer.alloc(32, 18).toString('base64');
const botToken = '123456789:fixture_token_that_is_not_a_real_secret';
const chatId = '12345678';
function machine(id: string, state: Machine['state'] = 'running'): Machine {
  return { id, name: id, state, orgId: 'org-fixture', operationId: null, revision: 1, autoSuspendAfterSeconds: 1800,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), spec: { vcpus: 2, memMiB: 1024 }, runtime: { ready: state === 'running' } };
}
async function fixture() {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-19', d1Databases: ['DB'] }));
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  await ensureDatabase(db);
  const encrypted = await encryptKey('ibk_fixture_account', dataKey, 'account-a');
  await db.prepare("INSERT INTO insb_accounts (id,label,instabox_user_id,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES ('account-a','主账号','user-a',?,?,'ount',?,?)")
    .bind(encrypted.ciphertext, encrypted.iv, new Date().toISOString(), new Date().toISOString()).run();
  const machines = new Map(Array.from({ length: 6 }, (_, index) => ['machine-' + index, machine('machine-' + index)] as const));
  const calls: { path: string; method: string; key: string; idempotency: string | null }[] = [];
  const messages: string[] = [];
  const telegramCalls: string[] = [];
  const operations = new Map<string, any>();
  const control = { loseReply: false, failResume: false, failTelegram: false, failList: false, failMachine: '', webhookSecret: '', machineHook: undefined as (() => Promise<void>) | undefined };
  const fetcher: Fetcher = async (input, init = {}) => {
    const url = new URL(String(input)), requestHeaders = new Headers(init.headers);
    if (url.hostname === 'api.telegram.org') {
      assert.ok(url.pathname.startsWith('/bot' + botToken + '/'));
      const method = url.pathname.split('/').pop(), body = JSON.parse(String(init.body));
      telegramCalls.push(method!);
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: 'fixture_bot' } });
      if (method === 'getChat') return Response.json({ ok: true, result: { id: Number(body.chat_id), type: 'private' } });
      if (method === 'setWebhook') { assert.equal(body.url, base + '/api/telegram/webhook'); control.webhookSecret = body.secret_token; return Response.json({ ok: true, result: true }); }
      if (method === 'sendMessage') {
        assert.equal(body.chat_id, chatId);
        if (control.failTelegram) { control.failTelegram = false; throw new Error('Telegram temporarily unavailable'); }
        messages.push(body.text);
      }
      return Response.json({ ok: true, result: true });
    }
    assert.equal(url.origin, 'https://api.instabox.sh');
    assert.equal(requestHeaders.has('Cookie'), false);
    const idempotency = requestHeaders.get('Idempotency-Key');
    calls.push({ path: url.pathname, method: init.method || 'GET', key: requestHeaders.get('X-API-Key') || '', idempotency });
    if (url.pathname === '/v1/machines') {
      if (control.failList) throw new Error('Temporary upstream failure');
      return Response.json({ machines: [...machines.values()], nextCursor: null });
    }
    if (url.pathname.startsWith('/v1/operations/')) {
      const operation = [...operations.values()].find(value => value.id === url.pathname.split('/').pop());
      assert.ok(operation);
      const current = machines.get(operation.machineId)!;
      current.state = operation.type === 'resume' ? 'running' : 'suspended'; current.operationId = null;
      operation.state = 'succeeded';
      return Response.json({ ...operation, machine: current });
    }
    const machineId = url.pathname.split('/')[3], current = machines.get(machineId);
    if (!current) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    if (init.method === 'POST') {
      if (control.failResume && url.pathname.endsWith('/resume')) {
        control.failResume = false;
        return Response.json({ error: { code: 'insufficient_scope' } }, { status: 403 });
      }
      let operation = operations.get(idempotency!);
      if (!operation) {
        operation = { id: 'operation-' + operations.size, machineId, type: url.pathname.split('/').pop(), state: 'queued' };
        operations.set(idempotency!, operation);
        current.state = operation.type === 'resume' ? 'resuming' : 'suspending'; current.operationId = operation.id;
      }
      if (control.loseReply) { control.loseReply = false; throw new Error('Response lost after acceptance'); }
      return Response.json(operation, { status: 202 });
    }
    if (control.failMachine === machineId) throw new Error('Unavailable machine query');
    await control.machineHook?.();
    return Response.json(current);
  };
  const app = createApp({ fetcher, authenticate: async () => ({ username: 'owner', key: dataKey }) });
  const env = { DB: db } as Env;
  async function call(path: string, method = 'GET', body?: unknown, extraHeaders = {}) {
    const response = await app.fetch(new Request(base + path, { method, headers: { ...headers, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    return { status: response.status, body: await response.json() as any };
  }
  let tick = Math.floor(Date.now() / 60000) * 60000;
  const run = () => runAutomation(env, tick += 60000, fetcher);
  const setPolicy = (id: string, mode = 'always', extra = {}) => call('/api/accounts/account-a/machines/' + id + '/keepalive', 'PUT', { mode, ...extra });
  const webhook = (updateId: number, text: string, extra: Record<string, unknown> = {}, secret = control.webhookSecret) =>
    app.fetch(new Request(base + '/api/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: updateId, message: { date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: 'private' }, from: { id: Number(chatId) }, text, ...extra } }) }), env);
  return { runtime, db, env, calls, messages, telegramCalls, operations, control, machines, fetcher, call, run, setPolicy, webhook };
}

async function writeLegacyCredentials(db: D1Database) {
  const encryptedData = await encryptKey(dataKey, automationSecret, 'automation:1');
  const encryptedToken = await encryptKey(botToken, automationSecret, 'telegram:1');
  await db.batch([
    db.prepare('INSERT INTO insb_automation (id,key_ciphertext,key_iv) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET key_ciphertext=excluded.key_ciphertext,key_iv=excluded.key_iv')
      .bind(encryptedData.ciphertext, encryptedData.iv),
    db.prepare('UPDATE insb_telegram SET token_ciphertext=?,token_iv=? WHERE id=1').bind(encryptedToken.ciphertext, encryptedToken.iv),
    db.prepare('DELETE FROM insb_automation_keys'),
  ]);
}

test('daily keepalive windows validate five ranges, overlaps, midnight boundaries and local time zones', () => {
  const policy = validateSchedule({ mode: 'windows', timezone: 'Asia/Shanghai', windows: [{ start: '22:00', end: '06:00' }, { start: '09:00', end: '12:00' }] });
  assert.equal(inKeepaliveWindow(policy, Date.parse('2026-10-22T14:00:00Z')), true);
  assert.equal(inKeepaliveWindow(policy, Date.parse('2026-10-22T21:59:59Z')), true);
  assert.equal(inKeepaliveWindow(policy, Date.parse('2026-10-22T22:00:00Z')), false);
  assert.equal(inKeepaliveWindow(policy, Date.parse('2026-10-22T01:00:00Z')), true);
  assert.equal(inKeepaliveWindow({ ...policy, mode: 'off' }, Date.now()), false);
  assert.throws(() => validateSchedule({ ...policy, windows: [...policy.windows, { start: '05:00', end: '07:00' }] }));
  assert.throws(() => validateSchedule({ ...policy, windows: Array(6).fill({ start: '01:00', end: '02:00' }) }));
  assert.throws(() => validateSchedule({ ...policy, timezone: 'Not/A_Timezone' }));
  assert.throws(() => validateSchedule({ ...policy, windows: [{ start: '09:00', end: '09:00' }] }));
  assert.throws(() => validateSchedule({ mode: ['always'] }));
});

test('keepalive runs with only D1, automatically managed keys, state checks and durable request deduplication', async context => {
  const fixtureState = await fixture();
  const { db, env, machines, calls, operations, control, call, setPolicy, run } = fixtureState;
  try {
    await context.test('configuration needs only DB, allows the database owner to recover credentials and never exposes them through APIs', async () => {
      assert.equal(env.AUTOMATION_SECRET, undefined);
      assert.equal((await setPolicy('machine-0', 'off')).status, 200);
      const result = await setPolicy('machine-0');
      assert.equal(result.status, 200); assert.equal(result.body.policies[0].mode, 'always');
      const persisted = JSON.stringify(await db.prepare('SELECT * FROM insb_automation').all());
      const keys = await db.prepare('SELECT wrapping_key FROM insb_automation_keys WHERE id=1').first<{ wrapping_key: string }>();
      assert.equal(Buffer.from(keys!.wrapping_key, 'base64').length, 32);
      const stored = await db.prepare('SELECT key_ciphertext,key_iv FROM insb_automation WHERE id=1').first<any>();
      assert.equal(await decryptKey(stored.key_ciphertext.slice(3), stored.key_iv, keys!.wrapping_key, 'automation:1'), dataKey);
      assert.equal(await automationDataKey(env), dataKey);
      for (const sensitive of [dataKey, automationSecret, 'ibk_fixture_account']) {
        assert.equal(persisted.includes(sensitive), false);
        assert.equal(JSON.stringify(result.body).includes(sensitive), false);
      }
      assert.equal(JSON.stringify(result.body).includes(keys!.wrapping_key), false);
      assert.equal((await call('/api/accounts/account-a/machines/machine-0/keepalive', 'PUT', { mode: 'always' }, { Origin: 'https://evil.test' })).status, 403);
    });
    await context.test('enabling policies concurrently cannot exceed five machines', async () => {
      const results = await Promise.all([1, 2, 3, 4, 5].map(index => setPolicy('machine-' + index)));
      assert.equal(results.filter(value => value.status === 200).length, 4);
      assert.equal(results.filter(value => value.status === 409).length, 1);
      await db.prepare("UPDATE insb_keepalive SET mode='off'").run();
      for (let index = 0; index < 5; index++) assert.equal((await setPolicy('machine-' + index)).status, 200);
    });
    await context.test('only suspended machines resume, duplicate cron events do not repeat effects, and failures stay isolated', async () => {
      machines.get('machine-1')!.state = 'suspended';
      machines.get('machine-2')!.state = 'stopped';
      machines.get('machine-3')!.state = 'resuming';
      control.failMachine = 'machine-4';
      const tick = Date.now();
      await Promise.all([runAutomation(env, tick, fixtureState.fetcher), runAutomation(env, tick, fixtureState.fetcher)]);
      assert.equal(operations.size, 1);
      assert.deepEqual(calls.filter(value => value.method === 'POST').map(value => value.path), ['/v1/machines/machine-1/resume']);
      const failed = await db.prepare('SELECT last_error FROM insb_keepalive WHERE machine_id=?').bind('machine-4').first<any>();
      assert.ok(failed.last_error);
      control.failMachine = '';
      await run();
      assert.equal((await db.prepare('SELECT state FROM insb_actions').first<any>())!.state, 'succeeded');
    });
    await context.test('lost resume responses reuse the original key after another scheduled invocation', async () => {
      machines.get('machine-1')!.state = 'suspended'; machines.get('machine-1')!.operationId = null;
      control.loseReply = true;
      await run();
      const action = await db.prepare("SELECT * FROM insb_actions WHERE state='unknown'").first<any>();
      assert.ok(action);
      const count = operations.size;
      await run();
      assert.equal(operations.size, count);
      assert.equal(calls.filter(value => value.idempotency === 'panel-' + action.id).length, 2);
      await run();
    });
    await context.test('disabling a policy during a status query prevents resume, and disabled accounts are skipped', async () => {
      machines.get('machine-1')!.state = 'suspended'; machines.get('machine-1')!.operationId = null;
      control.machineHook = async () => { await db.prepare("UPDATE insb_keepalive SET mode='off',version=version+1 WHERE machine_id='machine-1'").run(); };
      const effects = operations.size;
      await run(); assert.equal(operations.size, effects);
      control.machineHook = undefined;
      await db.prepare("UPDATE insb_accounts SET enabled=0 WHERE id='account-a'").run();
      const previous = calls.length; await run(); assert.equal(calls.length, previous);
      await db.prepare("UPDATE insb_accounts SET enabled=1 WHERE id='account-a'").run();
    });
    await context.test('a definitive resume failure waits five minutes before creating another operation', async () => {
      await setPolicy('machine-1');
      machines.get('machine-1')!.state = 'suspended'; machines.get('machine-1')!.operationId = null;
      control.failResume = true;
      await run();
      const failed = await db.prepare("SELECT * FROM insb_actions WHERE machine_id='machine-1' AND state='failed' ORDER BY created_at DESC LIMIT 1").first<any>();
      assert.ok(failed); assert.equal(failed.error_code, 'insufficient_scope');
      const submissions = calls.filter(value => value.method === 'POST').length;
      await run(); assert.equal(calls.filter(value => value.method === 'POST').length, submissions);
      await db.prepare('UPDATE insb_actions SET updated_at=? WHERE id=?').bind(new Date(Date.now() - 360000).toISOString(), failed.id).run();
      await run(); assert.equal(calls.filter(value => value.method === 'POST').length, submissions + 1);
      await run();
    });
    await context.test('time windows outside the current minute cause no upstream requests', async () => {
      await db.prepare("UPDATE insb_keepalive SET mode='off'").run();
      const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      const start = (minute + 120) % 1440, end = (start + 1) % 1440;
      const time = (value: number) => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
      await setPolicy('machine-0', 'windows', { timezone: 'UTC', windows: [{ start: time(start), end: time(end) }] });
      const previous = calls.length; await run(); assert.equal(calls.length, previous);
    });
  } finally { await fixtureState.runtime.dispose(); }
});

test('Telegram commands and offline notifications are private, authenticated and deduplicated', async context => {
  const fixtureState = await fixture();
  const { db, call, webhook, messages, operations, machines, control, run } = fixtureState;
  try {
    await context.test('binding verifies the bot and private chat, encrypts its token and defaults notifications off', async () => {
      assert.equal((await call('/api/telegram')).body.notifyOffline, false);
      const configured = await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: false });
      assert.equal(configured.status, 200); assert.equal(configured.body.username, 'fixture_bot');
      assert.equal(JSON.stringify(configured).includes(botToken), false);
      assert.equal(JSON.stringify(await db.prepare('SELECT * FROM insb_telegram').all()).includes(botToken), false);
      assert.equal((await call('/api/telegram', 'PUT', { botToken, chatId: '-123', notifyOffline: false })).status, 400);
      assert.equal(messages.length, 0);
    });
    await context.test('forged webhooks, foreign users and group messages cannot read accounts or control machines', async () => {
      assert.equal((await webhook(1, '/accounts', {}, 'x'.repeat(43))).status, 403);
      assert.equal((await webhook(2, '/accounts', { from: { id: 999 } })).status, 200);
      assert.equal((await webhook(3, '/accounts', { chat: { id: Number(chatId), type: 'group' } })).status, 200);
      assert.equal(messages.length, 0); assert.equal(operations.size, 0);
    });
    await context.test('account, machine and state queries work without sending API keys to Telegram', async () => {
      await webhook(4, '/accounts'); assert.ok(messages.at(-1)!.includes('主账号'));
      await webhook(5, '/machines account-a'); assert.ok(messages.at(-1)!.includes('machine-0'));
      await webhook(6, '/status account-a machine-0'); assert.ok(messages.at(-1)!.includes('运行中'));
      for (const text of messages) { assert.equal(text.includes('ibk_'), false); assert.equal(text.includes(dataKey), false); }
    });
    await context.test('resume and suspend persist idempotent actions, and duplicate webhook deliveries cannot repeat effects', async () => {
      machines.get('machine-0')!.state = 'suspended';
      assert.equal((await webhook(7, '/resume account-a machine-0')).status, 200);
      assert.equal(operations.size, 1); assert.ok(messages.at(-1)!.includes('已受理'));
      const delivered = messages.length;
      await webhook(7, '/resume account-a machine-0');
      assert.equal(operations.size, 1); assert.equal(messages.length, delivered);
      await webhook(8, '/status account-a machine-0');
      assert.ok(messages.at(-1)!.includes('运行中'));
      control.failTelegram = true;
      assert.equal((await webhook(9, '/suspend account-a machine-0')).status, 503);
      const effects = operations.size;
      assert.equal((await webhook(9, '/suspend account-a machine-0', { date: Math.floor(Date.now() / 1000) - 600 })).status, 200);
      assert.equal(operations.size, effects);
      const deliveredAfterRetry = messages.length;
      await webhook(999, '/accounts', { date: Math.floor(Date.now() / 1000) - 600 });
      assert.equal(messages.length, deliveredAfterRetry);
    });
    await context.test('offline monitoring establishes a baseline and sends one notice per offline episode, with retry on send failure', async () => {
      await webhook(10, '/notifications on');
      machines.get('machine-0')!.state = 'running'; machines.get('machine-0')!.operationId = null;
      const delivered = messages.length;
      await run(); assert.equal(messages.length, delivered);
      machines.get('machine-0')!.state = 'suspended';
      await run(); assert.equal(messages.length, delivered + 1); assert.ok(messages.at(-1)!.includes('机器离线'));
      await run(); assert.equal(messages.length, delivered + 1);
      machines.get('machine-0')!.state = 'running'; await run();
      control.failList = true; await run(); assert.equal(messages.length, delivered + 1); control.failList = false;
      machines.get('machine-0')!.state = 'stopped'; control.failTelegram = true;
      await run(); assert.equal(messages.length, delivered + 1);
      await run(); assert.equal(messages.length, delivered + 2);
      await run(); assert.equal(messages.length, delivered + 2);
      await webhook(11, '/notifications off');
      const disabled = messages.length; machines.get('machine-1')!.state = 'error';
      await run(); assert.equal(messages.length, disabled);
    });
    await context.test('disconnecting clears webhook authorization and disables notifications', async () => {
      const oldSecret = control.webhookSecret;
      assert.equal((await call('/api/telegram', 'DELETE', {})).status, 200);
      assert.equal((await call('/api/telegram')).body.enabled, false);
      assert.equal((await webhook(12, '/accounts', {}, oldSecret)).status, 403);
    });
  } finally { await fixtureState.runtime.dispose(); }
});

test('automation budgets and cross-channel races do not prevent keepalive or duplicate machine actions', async context => {
  await context.test('notifications reserve ten requests for five keepalive machines and rotate account priority', async () => {
    const fixtureState = await fixture();
    const { db, call, setPolicy, machines, calls, operations, run } = fixtureState;
    try {
      for (let index = 0; index < 5; index++) { await setPolicy('machine-' + index); machines.get('machine-' + index)!.state = 'suspended'; }
      for (let index = 0; index < 28; index++) {
        const accountId = 'extra-account-' + String(index).padStart(2, '0');
        const encrypted = await encryptKey('ibk_fixture_' + index, dataKey, accountId);
        await db.prepare('INSERT INTO insb_accounts (id,label,instabox_user_id,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(accountId, accountId, accountId, encrypted.ciphertext, encrypted.iv, 'test', new Date().toISOString(), new Date().toISOString()).run();
      }
      assert.equal((await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true })).status, 200);
      const before = calls.length;
      await run();
      const first = calls.slice(before);
      assert.equal(first.filter(value => value.path === '/v1/machines').length, 25);
      assert.equal(first.length, 35); assert.equal(operations.size, 5);
      assert.ok((await call('/api/telegram')).body.lastError.includes('预算'));
      const nextBefore = calls.length;
      await run();
      const next = calls.slice(nextBefore);
      assert.notEqual(next[0].key, first[0].key);
      assert.ok(next.length <= 35);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('manual controls, Telegram commands and cron atomically share the per-machine action lock', async () => {
    const fixtureState = await fixture();
    const { db, call, webhook, setPolicy, machines, operations, run } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: false });
      await setPolicy('machine-0'); machines.get('machine-0')!.state = 'suspended';
      await Promise.all([
        run(),
        call('/api/accounts/account-a/machines/machine-0/actions', 'POST', { type: 'resume', requestId: crypto.randomUUID() }),
        call('/api/accounts/account-a/machines/machine-0/actions', 'POST', { type: 'resume', requestId: crypto.randomUUID() }),
        webhook(1, '/resume account-a machine-0'),
      ]);
      assert.equal(operations.size, 1);
      const actions = await db.prepare("SELECT id FROM insb_actions WHERE machine_id='machine-0'").all();
      assert.equal(actions.results.length, 1);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('changing or removing the old environment secret does not affect DB-managed keepalive or Telegram', async () => {
    const fixtureState = await fixture();
    const { env, call, setPolicy, machines, operations, run } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      env.AUTOMATION_SECRET = Buffer.alloc(32, 19).toString('base64');
      await setPolicy('machine-0'); machines.get('machine-0')!.state = 'suspended';
      await run(); assert.equal(operations.size, 1);
      assert.equal((await call('/api/telegram')).body.lastError, '');
      delete env.AUTOMATION_SECRET;
      await run(); assert.equal((await call('/api/telegram')).body.tokenRequired, false);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('account deletion cannot erase credentials when a machine action arrives after its initial pending check', async () => {
    const fixtureState = await fixture();
    const { db, env, call, setPolicy, machines } = fixtureState;
    try {
      await setPolicy('machine-0');
      env.DB = new Proxy(db, { get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          await createAction(db, 'account-a', machines.get('machine-0')!, 'suspend', crypto.randomUUID());
          return target.batch(statements);
        };
        const member = Reflect.get(target, property);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      const removed = await call('/api/accounts/account-a', 'DELETE', {});
      assert.equal(removed.status, 409); assert.equal(removed.body.error.code, 'pending_actions');
      const account = await db.prepare("SELECT key_ciphertext,deleted_at,enabled FROM insb_accounts WHERE id='account-a'").first<any>();
      assert.ok(account.key_ciphertext); assert.equal(account.deleted_at, null); assert.equal(account.enabled, 1);
      assert.equal((await db.prepare("SELECT mode FROM insb_keepalive WHERE machine_id='machine-0'").first<any>()).mode, 'always');
      env.DB = db;
    } finally { await fixtureState.runtime.dispose(); }
  });
});

test('offline monitoring preserves pending events after recovery and verifies shared-machine disappearance', async context => {
  await context.test('a failed offline notification is delivered after keepalive recovers the machine', async () => {
    const fixtureState = await fixture();
    const { db, call, run, setPolicy, control, machines, messages } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      await setPolicy('machine-0'); await run();
      machines.get('machine-0')!.state = 'suspended'; control.failTelegram = true;
      await run(); assert.equal(messages.length, 0);
      control.failTelegram = true;
      await run(); assert.equal(machines.get('machine-0')!.state, 'running'); assert.equal(messages.length, 0);
      await run(); assert.equal(messages.length, 1);
      assert.ok(messages[0].includes('机器离线')); assert.ok(messages[0].includes('当前已恢复运行'));
      const watch = await db.prepare("SELECT state,pending_text FROM insb_machine_watch WHERE machine_id='machine-0'").first<any>();
      assert.equal(watch.state, 'running'); assert.equal(watch.pending_text, null);
      await run(); assert.equal(messages.length, 1);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('one account losing visibility does not mark a machine visible to another account as deleted', async () => {
    const fixtureState = await fixture();
    const { db, env, call, fetcher, machines, messages } = fixtureState;
    try {
      const encrypted = await encryptKey('ibk_shared_account', dataKey, 'account-b');
      await db.prepare("INSERT INTO insb_accounts (id,label,instabox_user_id,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES ('account-b','共享账号','user-b',?,?,'test',?,?)")
        .bind(encrypted.ciphertext, encrypted.iv, new Date().toISOString(), new Date().toISOString()).run();
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      await checkTelegramNotifications(env, dataKey, fetcher);
      const changedVisibility: Fetcher = (input, init) => {
        if (new URL(String(input)).pathname === '/v1/machines' && new Headers(init?.headers).get('X-API-Key') === 'ibk_fixture_account')
          return Promise.resolve(Response.json({ machines: [], nextCursor: null }));
        return fetcher(input, init);
      };
      await checkTelegramNotifications(env, dataKey, changedVisibility); assert.equal(messages.length, 0);
      await db.prepare("UPDATE insb_accounts SET enabled=0 WHERE id='account-a'").run();
      await checkTelegramNotifications(env, dataKey, changedVisibility); assert.equal(messages.length, 0);
      machines.delete('machine-0');
      await checkTelegramNotifications(env, dataKey, changedVisibility); assert.equal(messages.length, 1);
      await checkTelegramNotifications(env, dataKey, changedVisibility); assert.equal(messages.length, 1);
    } finally { await fixtureState.runtime.dispose(); }
  });
});

test('Telegram settings preserve offline deduplication and fail closed if webhook storage fails', async context => {
  await context.test('repeated notification commands and unchanged panel settings keep the existing baseline', async () => {
    const fixtureState = await fixture();
    const { db, call, webhook, run, machines, messages } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      await run();
      machines.get('machine-0')!.state = 'suspended';
      await run();
      const watched = await db.prepare('SELECT * FROM insb_machine_watch ORDER BY machine_id').all();
      await webhook(1, '/notifications on');
      assert.deepEqual((await db.prepare('SELECT * FROM insb_machine_watch ORDER BY machine_id').all()).results, watched.results);
      await call('/api/telegram', 'PUT', { botToken: '', chatId, notifyOffline: true });
      assert.deepEqual((await db.prepare('SELECT * FROM insb_machine_watch ORDER BY machine_id').all()).results, watched.results);
      const delivered = messages.length; await run(); assert.equal(messages.length, delivered);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('failed storage unregisters the unsaved webhook and a new save restores binding', async () => {
    const fixtureState = await fixture();
    const { db, env, call, webhook, telegramCalls } = fixtureState;
    try {
      const failingDatabase = new Proxy(db, { get(target, property) {
        if (property === 'batch') return async () => { throw new Error('D1 unavailable after webhook registration'); };
        const member = Reflect.get(target, property);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
      env.DB = failingDatabase;
      const failed = await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: false });
      assert.equal(failed.status, 503); assert.equal(failed.body.error.code, 'telegram_binding_incomplete');
      assert.equal(telegramCalls.at(-1), 'deleteWebhook');
      assert.equal((await webhook(1, '/accounts')).status, 403);
      env.DB = db;
      assert.equal((await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: false })).status, 200);
      assert.equal((await webhook(2, '/accounts')).status, 200);
    } finally { await fixtureState.runtime.dispose(); }
  });
});

test('database-managed automation keys initialize concurrently and upgrade existing personal deployments', async context => {
  await context.test('an upgraded database adds the new key table without clearing policies, tokens or other application data', async () => {
    const fixtureState = await fixture();
    const { db, env, call, setPolicy } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: false });
      await setPolicy('machine-0');
      await writeLegacyCredentials(db);
      await db.prepare('DROP TABLE insb_automation_keys').run();
      await db.prepare("DELETE FROM insb_d1_migrations WHERE name='0005_automation_keys.sql'").run();
      await db.prepare('CREATE TABLE other_app_state (id INTEGER PRIMARY KEY,payload TEXT)').run();
      await db.prepare("INSERT INTO other_app_state VALUES (1,'unchanged')").run();
      const policy = await db.prepare("SELECT mode,version FROM insb_keepalive WHERE machine_id='machine-0'").first();
      const authorization = await db.prepare('SELECT webhook_hash,chat_id FROM insb_telegram WHERE id=1').first();
      env.AUTOMATION_SECRET = automationSecret;
      assert.equal((await call('/api/keepalive')).status, 200);
      assert.equal((await db.prepare("SELECT name FROM insb_d1_migrations WHERE name='0005_automation_keys.sql'").first<any>()).name, '0005_automation_keys.sql');
      assert.deepEqual(await db.prepare("SELECT mode,version FROM insb_keepalive WHERE machine_id='machine-0'").first(), policy);
      assert.deepEqual(await db.prepare('SELECT webhook_hash,chat_id FROM insb_telegram WHERE id=1').first(), authorization);
      assert.deepEqual(await db.prepare('SELECT payload FROM other_app_state WHERE id=1').first(), { payload: 'unchanged' });
      delete env.AUTOMATION_SECRET;
      assert.equal(await automationDataKey(env), dataKey);
      assert.equal((await call('/api/telegram')).body.tokenRequired, false);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('concurrent initialization creates one stable database key without any environment secret', async () => {
    const fixtureState = await fixture();
    const { db, env, call } = fixtureState;
    try {
      env.AUTOMATION_SECRET = 'invalid-old-secret';
      await Promise.all(Array.from({ length: 8 }, () => enableAutomation(env, dataKey)));
      const stored = await db.prepare('SELECT wrapping_key FROM insb_automation_keys').all<{ wrapping_key: string }>();
      assert.equal(stored.results.length, 1);
      assert.equal(Buffer.from(stored.results[0].wrapping_key, 'base64').length, 32);
      delete env.AUTOMATION_SECRET;
      assert.equal(await automationDataKey(env), dataKey);
      await enableAutomation(env, dataKey);
      assert.deepEqual((await db.prepare('SELECT wrapping_key FROM insb_automation_keys').all()).results, stored.results);
      for (const path of ['/api/keepalive', '/api/telegram', '/api/accounts']) {
        const response = await call(path);
        assert.equal(response.status, 200);
        for (const sensitive of [dataKey, stored.results[0].wrapping_key]) assert.equal(JSON.stringify(response.body).includes(sensitive), false);
      }
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('cron migrates legacy keys and bot tokens while preserving policies, credentials and webhook authorization', async () => {
    const fixtureState = await fixture();
    const { db, env, call, setPolicy, run, webhook, machines, operations } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      await setPolicy('machine-0'); await run();
      const account = await db.prepare("SELECT key_ciphertext,key_iv FROM insb_accounts WHERE id='account-a'").first();
      const policy = await db.prepare("SELECT mode,version,timezone,windows_json FROM insb_keepalive WHERE machine_id='machine-0'").first();
      const authorization = await db.prepare('SELECT webhook_hash,chat_id FROM insb_telegram WHERE id=1').first();
      await writeLegacyCredentials(db);
      env.AUTOMATION_SECRET = automationSecret;
      machines.get('machine-0')!.state = 'suspended';
      await run(); assert.equal(operations.size, 1);
      assert.equal((await db.prepare('SELECT key_ciphertext FROM insb_automation').first<any>()).key_ciphertext.startsWith('d1:'), true);
      assert.equal((await db.prepare('SELECT token_ciphertext FROM insb_telegram').first<any>()).token_ciphertext.startsWith('d1:'), true);
      assert.deepEqual(await db.prepare("SELECT key_ciphertext,key_iv FROM insb_accounts WHERE id='account-a'").first(), account);
      assert.deepEqual(await db.prepare("SELECT mode,version,timezone,windows_json FROM insb_keepalive WHERE machine_id='machine-0'").first(), policy);
      assert.deepEqual(await db.prepare('SELECT webhook_hash,chat_id FROM insb_telegram WHERE id=1').first(), authorization);
      delete env.AUTOMATION_SECRET;
      assert.equal(await automationDataKey(env), dataKey);
      assert.equal((await webhook(1, '/status account-a machine-0')).status, 200);
      assert.equal((await call('/api/telegram')).body.tokenRequired, false);
      await run(); assert.equal(operations.size, 1);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('opening the logged-in panel recovers legacy keepalive without its old secret and allows re-entering the original bot token', async () => {
    const fixtureState = await fixture();
    const { db, env, call, setPolicy, run, webhook, machines, operations } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      await setPolicy('machine-0');
      await writeLegacyCredentials(db);
      assert.equal(env.AUTOMATION_SECRET, undefined);
      const overview = await call('/api/keepalive');
      assert.equal(overview.status, 200); assert.equal(overview.body.policies[0].mode, 'always');
      machines.get('machine-0')!.state = 'suspended';
      await run(); assert.equal(operations.size, 1);
      const settings = await call('/api/telegram');
      assert.equal(settings.status, 200); assert.equal(settings.body.enabled, true); assert.equal(settings.body.tokenRequired, true);
      assert.equal((await call('/api/telegram', 'PUT', { botToken: '', chatId, notifyOffline: true })).body.error.code, 'telegram_token_required');
      const repaired = await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: true });
      assert.equal(repaired.status, 200); assert.equal(repaired.body.tokenRequired, false);
      assert.equal(repaired.body.lastError, ''); assert.equal(JSON.stringify(repaired.body).includes(botToken), false);
      assert.equal((await webhook(1, '/status account-a machine-0')).status, 200);
      assert.equal(await automationDataKey(env), dataKey);
    } finally { await fixtureState.runtime.dispose(); }
  });
  await context.test('invalid persisted keys surface database errors instead of replacing the key and losing existing encrypted tokens', async () => {
    const fixtureState = await fixture();
    const { db, env, call, setPolicy } = fixtureState;
    try {
      await call('/api/telegram', 'PUT', { botToken, chatId, notifyOffline: false });
      const token = await db.prepare('SELECT token_ciphertext,token_iv FROM insb_telegram').first();
      const data = await db.prepare('SELECT key_ciphertext,key_iv FROM insb_automation').first();
      await db.prepare("UPDATE insb_automation_keys SET wrapping_key='invalid' WHERE id=1").run();
      const response = await setPolicy('machine-0');
      assert.equal(response.status, 503); assert.equal(response.body.error.code, 'automation_key_invalid');
      await assert.rejects(() => automationDataKey(env), (error: any) => error.code === 'automation_key_invalid');
      assert.deepEqual(await db.prepare('SELECT token_ciphertext,token_iv FROM insb_telegram').first(), token);
      assert.deepEqual(await db.prepare('SELECT key_ciphertext,key_iv FROM insb_automation').first(), data);
      assert.equal((await db.prepare('SELECT wrapping_key FROM insb_automation_keys').first<any>()).wrapping_key, 'invalid');
    } finally { await fixtureState.runtime.dispose(); }
  });
});

test('the deployed worker exports authenticated fetch and a real workerd scheduled handler without login cookies', async () => {
  const bundle = await build({ entryPoints: ['src/worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.sql': 'text' } });
  const upstream = `export default { async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.has('Cookie') || request.headers.get('X-API-Key') !== 'ibk_workerd_fixture') return new Response('credential error', { status: 403 });
    if (url.pathname === '/v1/machines/workerd-machine') return Response.json({ id: 'workerd-machine', name: 'workerd machine', state: 'suspended' });
    if (url.pathname.endsWith('/resume')) {
      if (!/^panel-[0-9a-f-]{36}$/.test(request.headers.get('Idempotency-Key') || '')) return new Response('idempotency error', { status: 400 });
      return Response.json({ id: 'workerd-operation', machineId: 'workerd-machine', type: 'resume', state: 'queued' }, { status: 202 });
    }
    if (url.pathname === '/v1/operations/workerd-operation') return Response.json({ id: 'workerd-operation', machineId: 'workerd-machine', type: 'resume', state: 'succeeded' });
    return new Response('not found', { status: 404 });
  } };`;
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'panel', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-19', d1Databases: ['DB'], outboundService: 'upstream' },
    { name: 'upstream', modules: true, script: upstream, compatibilityDate: '2026-10-19' },
  ] }));
  try {
    assert.equal((await runtime.dispatchFetch(base + '/api/accounts')).status, 401);
    assert.equal((await runtime.dispatchFetch(base + '/api/session')).status, 200);
    const db = await runtime.getD1Database('DB', 'panel') as unknown as D1Database;
    const encrypted = await encryptKey('ibk_workerd_fixture', dataKey, 'workerd-account');
    const timestamp = new Date().toISOString();
    await db.prepare("INSERT INTO insb_accounts (id,label,instabox_user_id,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES ('workerd-account','Cron fixture','workerd-user',?,?,'test',?,?)")
      .bind(encrypted.ciphertext, encrypted.iv, timestamp, timestamp).run();
    await enableAutomation({ DB: db }, dataKey);
    await db.prepare("INSERT INTO insb_keepalive (machine_id,account_id,machine_name,mode,updated_at) VALUES ('workerd-machine','workerd-account','Cron fixture','always',?)").bind(timestamp).run();
    const worker = await runtime.getWorker('panel');
    const scheduledTime = new Date();
    assert.equal((await worker.scheduled({ cron: '* * * * *', scheduledTime })).outcome, 'ok');
    const action = await db.prepare('SELECT state,operation_id FROM insb_actions').first<any>();
    assert.equal(action.state, 'queued'); assert.equal(action.operation_id, 'workerd-operation');
    assert.equal((await worker.scheduled({ cron: '* * * * *', scheduledTime })).outcome, 'ok');
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_actions').first<any>()).total, 1);
    assert.equal((await worker.scheduled({ cron: '* * * * *', scheduledTime: new Date(scheduledTime.getTime() + 60000) })).outcome, 'ok');
    assert.equal((await db.prepare('SELECT state FROM insb_actions').first<any>()).state, 'succeeded');
  } finally { await runtime.dispose(); }
});
