import type { TelegramStatus } from '../shared/telegram';
import { stateLabels, type Machine, type ActionType } from '../shared/types';
import { automationDataKey, automationSecret, enableAutomation, hasAutomationSecret, type AutomationEnv } from './automation';
import { encryptKey, decryptKey } from './crypto';
import { digest, encode } from './password';
import { database, ensureDatabase } from './schema';
import { PanelError } from './errors';
import { type AccountRow, type ActionRow } from './db';
import { Instabox, type Fetcher } from './instabox';
import { applyOperation, createAction } from './actions';

interface BotRow {
  id: number; username: string; chat_id: string; token_ciphertext: string; token_iv: string;
  webhook_hash: string; notify_offline: number; last_error: string; updated_at: string;
}
interface TelegramMessage { text?: string; date?: number; from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string } }
interface TelegramUpdate { update_id: number; message?: TelegramMessage }
interface WatchRow { machine_id: string; account_id: string; state: string; pending_text: string | null }
const defaultFetcher: Fetcher = (input, init) => fetch(input, init);
const ongoing = ['submitting', 'queued', 'running', 'unknown'];
const label = (value: string) => value.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 80);

class Telegram {
  constructor(private token: string, private fetcher: Fetcher = defaultFetcher) {}
  async request(method: string, body: Record<string, unknown> = {}): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.telegram.org/bot' + this.token + '/' + method, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof PanelError && error.code === 'automation_budget') throw error;
      throw new PanelError(502, 'telegram_unreachable', '暂时无法连接 Telegram，请稍后重试。', true);
    }
    const data = await response.json().catch(() => null) as any;
    if (!response.ok || data?.ok !== true) throw new PanelError(502, 'telegram_request_failed', 'Telegram 请求失败，请检查机器人 Token、聊天 ID，并先向机器人发送 /start。', true);
    return data.result;
  }
  async send(chatId: string, text: string) {
    for (let offset = 0; offset < text.length; offset += 3500)
      await this.request('sendMessage', { chat_id: chatId, text: text.slice(offset, offset + 3500), link_preview_options: { is_disabled: true } });
  }
}
async function botRow(db: D1Database) { return db.prepare('SELECT * FROM insb_telegram WHERE id=1').first<BotRow>(); }
async function botClient(env: AutomationEnv, row: BotRow, fetcher?: Fetcher) {
  return new Telegram(await decryptKey(row.token_ciphertext, row.token_iv, automationSecret(env), 'telegram:1'), fetcher);
}
export async function telegramStatus(env: AutomationEnv): Promise<TelegramStatus> {
  await ensureDatabase(database(env));
  const row = await botRow(env.DB);
  return { configured: hasAutomationSecret(env), enabled: Boolean(row), username: row?.username || '', chatId: row?.chat_id || '',
    notifyOffline: Boolean(row?.notify_offline), lastError: row?.last_error || '' };
}
export async function saveTelegram(env: AutomationEnv, value: unknown, origin: string, dataKey: string, fetcher?: Fetcher) {
  await ensureDatabase(database(env));
  const body = value as { botToken?: unknown; chatId?: unknown; notifyOffline?: unknown } | null;
  if (!body || typeof body.chatId !== 'string' || !/^[1-9]\d{0,15}$/.test(body.chatId) || typeof body.notifyOffline !== 'boolean')
    throw new PanelError(400, 'invalid_telegram', '请填写个人聊天的数字 ID，并选择是否启用通知。');
  const wrappingKey = automationSecret(env), previous = await botRow(env.DB);
  const oldToken = previous ? await decryptKey(previous.token_ciphertext, previous.token_iv, wrappingKey, 'telegram:1') : '';
  const token = typeof body.botToken === 'string' && body.botToken.trim() ? body.botToken.trim() : oldToken;
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new PanelError(400, 'invalid_bot_token', '请输入 BotFather 提供的完整 Bot Token。');
  if (previous && token !== oldToken) throw new PanelError(409, 'bot_already_bound', '更换机器人前，请先解除当前绑定。');
  const telegram = new Telegram(token, fetcher);
  const identity = await telegram.request('getMe');
  if (!identity?.is_bot || typeof identity.username !== 'string') throw new PanelError(502, 'invalid_bot', '无法验证 Telegram 机器人。');
  const chat = await telegram.request('getChat', { chat_id: body.chatId });
  if (chat?.type !== 'private' || String(chat.id) !== body.chatId) throw new PanelError(400, 'private_chat_required', '仅支持绑定你自己的私人聊天，不支持群组或频道。');
  await enableAutomation(env, dataKey);
  const webhookSecret = encode(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const encrypted = await encryptKey(token, wrappingKey, 'telegram:1');
  await telegram.request('setWebhook', { url: origin + '/api/telegram/webhook', secret_token: webhookSecret, allowed_updates: ['message'], max_connections: 1 });
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM insb_machine_watch WHERE NOT EXISTS
        (SELECT id FROM insb_telegram WHERE id=1 AND chat_id=? AND notify_offline=?)`)
        .bind(body.chatId, Number(body.notifyOffline)),
      env.DB.prepare(`INSERT INTO insb_telegram (id,username,chat_id,token_ciphertext,token_iv,webhook_hash,notify_offline,updated_at)
        VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,chat_id=excluded.chat_id,
        token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,webhook_hash=excluded.webhook_hash,
        notify_offline=excluded.notify_offline,last_error='',updated_at=excluded.updated_at`)
        .bind(identity.username, body.chatId, encrypted.ciphertext, encrypted.iv, await digest(webhookSecret), Number(body.notifyOffline), new Date().toISOString()),
    ]);
  } catch {
    try { await telegram.request('deleteWebhook', { drop_pending_updates: false }); } catch {}
    throw new PanelError(503, 'telegram_binding_incomplete', '机器人 Webhook 已设置，但数据库保存未完成；未保存的 Webhook 不会获得控制权限，请重新保存绑定。', true);
  }
  return telegramStatus(env);
}
export async function removeTelegram(env: AutomationEnv, fetcher?: Fetcher) {
  await ensureDatabase(database(env));
  const row = await botRow(env.DB);
  let warning = '';
  if (row) {
    try { await (await botClient(env, row, fetcher)).request('deleteWebhook', { drop_pending_updates: true }); }
    catch { warning = '本地绑定已解除；Telegram 端 Webhook 未确认移除，可通过 BotFather 撤销旧 Token。'; }
  }
  await env.DB.batch([env.DB.prepare('DELETE FROM insb_telegram'), env.DB.prepare('DELETE FROM insb_machine_watch'), env.DB.prepare('DELETE FROM insb_telegram_updates')]);
  return { ok: true, warning };
}
async function findAccount(db: D1Database, reference: string) {
  const matches = await db.prepare('SELECT * FROM insb_accounts WHERE deleted_at IS NULL AND (id=? OR label=?) LIMIT 2').bind(reference, reference).all<AccountRow>();
  if (matches.results.length !== 1) throw new PanelError(400, 'account_reference', '账号不存在或别名不唯一，请用 /accounts 查询并使用完整账号 ID。');
  const account = matches.results[0];
  if (!account.enabled) throw new PanelError(409, 'account_disabled', '这个账号已停用，请先在面板启用。');
  return account;
}
async function submitAction(env: AutomationEnv, account: AccountRow, remote: Instabox, machine: Machine, type: ActionType, requestId: string) {
  let action = await env.DB.prepare('SELECT * FROM insb_actions WHERE id=?').bind(requestId).first<ActionRow>();
  if (!action) {
    if (machine.state !== (type === 'resume' ? 'suspended' : 'running') || machine.operationId)
      return '机器当前为“' + stateLabels[machine.state] + '”，无需执行该命令。停止的机器请先在面板启动。';
    action = (await createAction(env.DB, account.id, machine, type, requestId)).action;
  }
  if (!action || action.account_id !== account.id || action.machine_id !== machine.id || action.type !== type)
    throw new PanelError(409, 'idempotency_conflict', '请求标识冲突，请重新发送命令。');
  if (!action.operation_id && ongoing.includes(action.state)) {
    try { await applyOperation(env.DB, action, await remote.change(machine.id, type, 'panel-' + action.id)); }
    catch (error) {
      const failure = error instanceof PanelError ? error : new PanelError(502, 'submission_uncertain', '操作结果待确认。');
      await env.DB.prepare("UPDATE insb_actions SET state=?,error_code=?,error_message=?,updated_at=? WHERE id=? AND state IN ('submitting','unknown')")
        .bind(failure.status >= 500 ? 'unknown' : 'failed', failure.code, failure.message, new Date().toISOString(), action.id).run();
    }
    action = (await env.DB.prepare('SELECT * FROM insb_actions WHERE id=?').bind(requestId).first<ActionRow>())!;
  }
  const description = action.state === 'succeeded' ? '已完成' : action.state === 'failed' ? '失败：' + action.error_message : action.state === 'unknown' ? '结果待确认，请到面板操作记录重试原请求' : '请求已受理，等待执行完成';
  const keepalive = type === 'suspend' && await env.DB.prepare("SELECT machine_id FROM insb_keepalive WHERE machine_id=? AND mode<>'off'").bind(machine.id).first();
  return (type === 'resume' ? '恢复' : '暂停') + ' ' + label(machine.name) + '：' + description + (keepalive ? '\n这台机器已开启保活，时间窗口内下一次检查可能自动恢复。' : '');
}
const help = 'InstaBox Panel\n/accounts [页码] — 查看绑定账号\n/machines 账号ID [页码] — 查看账号机器\n/status 账号ID 机器ID — 查询状态\n/resume 账号ID 机器ID — 恢复暂停机器\n/suspend 账号ID 机器ID — 暂停运行机器\n/notifications on 或 off — 开关离线通知\n/help — 显示帮助\n账号可以使用唯一别名；机器使用完整 ID。';
async function command(env: AutomationEnv, bot: BotRow, text: string, requestId: string, fetcher?: Fetcher) {
  const [raw, ...args] = text.trim().split(/\s+/);
  const name = raw.split('@')[0].toLowerCase();
  if (['/start', '/help'].includes(name)) return help;
  if (name === '/accounts') {
    const page = Number(args[0] || '1');
    if (!Number.isSafeInteger(page) || page < 1) return '页码需要为正整数。';
    const accounts = await env.DB.prepare('SELECT * FROM insb_accounts WHERE deleted_at IS NULL ORDER BY created_at,id LIMIT 11 OFFSET ?').bind((page - 1) * 10).all<AccountRow>();
    return accounts.results.length ? accounts.results.slice(0, 10).map(account => label(account.label) + (account.enabled ? ' · 已启用' : ' · 已停用') + '\n/machines ' + account.id).join('\n\n') + (accounts.results.length > 10 ? '\n\n下一页：/accounts ' + (page + 1) : '') : '没有更多绑定账号，请先在面板添加。';
  }
  if (name === '/notifications') {
    if (!['on', 'off'].includes(args[0])) return '用法：/notifications on 或 /notifications off';
    const enabled = Number(args[0] === 'on');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM insb_machine_watch WHERE EXISTS(SELECT id FROM insb_telegram WHERE id=1 AND webhook_hash=? AND notify_offline<>?)').bind(bot.webhook_hash, enabled),
      env.DB.prepare('UPDATE insb_telegram SET notify_offline=? WHERE id=1 AND webhook_hash=? AND notify_offline<>?').bind(enabled, bot.webhook_hash, enabled),
    ]);
    return args[0] === 'on' ? '离线通知已开启。第一次检查建立基线，之后从运行变为暂停、停止或异常时通知；同一次离线不会持续提醒。' : '离线通知已关闭。';
  }
  if (!['/machines', '/status', '/resume', '/suspend'].includes(name)) return help;
  if (!args[0] || (name !== '/machines' && !args[1])) return '请按帮助提供账号 ID 和机器 ID。\n' + help;
  const account = await findAccount(env.DB, args[0]);
  const dataKey = await automationDataKey(env);
  const remote = new Instabox(await decryptKey(account.key_ciphertext, account.key_iv, dataKey, account.id), fetcher);
  if (name === '/machines') {
    const page = Number(args[1] || '1');
    if (!Number.isSafeInteger(page) || page < 1) return '页码需要为正整数。';
    const machines = await remote.list(), selected = machines.slice((page - 1) * 8, page * 8);
    return label(account.label) + '\n' + (selected.length ? selected.map(machine => label(machine.name) + ' · ' + stateLabels[machine.state] + '\n/status ' + account.id + ' ' + machine.id).join('\n\n') : '没有更多机器。') + (machines.length > page * 8 ? '\n下一页：/machines ' + account.id + ' ' + (page + 1) : '');
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args[1])) return '机器 ID 格式无效。';
  const pending = await env.DB.prepare("SELECT * FROM insb_actions WHERE account_id=? AND machine_id=? AND state IN ('submitting','queued','running','unknown') ORDER BY created_at DESC LIMIT 1").bind(account.id, args[1]).first<ActionRow>();
  if (pending?.operation_id) await applyOperation(env.DB, pending, await remote.operation(pending.operation_id, 0));
  const machine = await remote.machine(args[1]);
  if (name === '/status') return label(machine.name) + ' · ' + stateLabels[machine.state] + '\n服务：' + (machine.runtime.ready ? '已就绪' : '未就绪') + '\n/resume ' + account.id + ' ' + machine.id + '\n/suspend ' + account.id + ' ' + machine.id;
  return submitAction(env, account, remote, machine, name === '/resume' ? 'resume' : 'suspend', requestId);
}
export async function telegramWebhook(env: AutomationEnv, request: Request, fetcher?: Fetcher): Promise<Response> {
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!/^[a-zA-Z0-9_-]{43}$/.test(header)) return new Response('Forbidden', { status: 403 });
  const db = database(env), bot = await botRow(db);
  if (!bot || await digest(header) !== bot.webhook_hash) return new Response('Forbidden', { status: 403 });
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  const message = update?.message;
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || !message ||
      message.chat?.type !== 'private' || String(message.chat.id) !== bot.chat_id || String(message.from?.id) !== bot.chat_id ||
      message.from?.is_bot || typeof message.text !== 'string' || !message.text.startsWith('/') || message.text.length > 1000)
    return Response.json({ ok: true });
  const timestamp = Date.now();
  let entry = await db.prepare('SELECT request_id,status FROM insb_telegram_updates WHERE update_id=?').bind(update.update_id).first<{ request_id: string; status: string }>();
  if (!entry) {
    if (typeof message.date === 'number' && Math.abs(timestamp - message.date * 1000) > 300000) return Response.json({ ok: true });
    await db.prepare('INSERT OR IGNORE INTO insb_telegram_updates (update_id,request_id,expires_at) VALUES (?,?,?)')
      .bind(update.update_id, crypto.randomUUID(), timestamp + 7 * 86400000).run();
    entry = await db.prepare('SELECT request_id,status FROM insb_telegram_updates WHERE update_id=?').bind(update.update_id).first<{ request_id: string; status: string }>();
  }
  if (!entry || entry.status === 'done') return Response.json({ ok: true });
  const claim = await db.prepare("UPDATE insb_telegram_updates SET status='processing',lease_until=? WHERE update_id=? AND status<>'done' AND lease_until<=?")
    .bind(timestamp + 60000, update.update_id, timestamp).run();
  if (!claim.meta.changes) return new Response('Retry later', { status: 503 });
  try {
    let reply: string;
    try { reply = await command(env, bot, message.text, entry.request_id, fetcher); }
    catch (error) { reply = error instanceof PanelError ? error.message : '请求暂时无法完成，请稍后重试。'; }
    const current = await botRow(db);
    if (current?.webhook_hash !== bot.webhook_hash) return Response.json({ ok: true });
    await (await botClient(env, bot, fetcher)).send(bot.chat_id, reply);
    await db.batch([db.prepare("UPDATE insb_telegram_updates SET status='done',lease_until=0 WHERE update_id=?").bind(update.update_id),
      db.prepare('DELETE FROM insb_telegram_updates WHERE expires_at<?').bind(timestamp)]);
    return Response.json({ ok: true });
  } catch {
    await db.prepare("UPDATE insb_telegram_updates SET status='pending',lease_until=0 WHERE update_id=?").bind(update.update_id).run();
    return new Response('Retry later', { status: 503 });
  }
}
export async function checkTelegramNotifications(env: AutomationEnv, dataKey: string, fetcher?: Fetcher, tick = 0) {
  const db = env.DB, bot = await botRow(db);
  if (!bot?.notify_offline) return;
  let telegram: Telegram;
  try { telegram = await botClient(env, bot, fetcher); }
  catch {
    await db.prepare('UPDATE insb_telegram SET last_error=? WHERE id=1 AND webhook_hash=?')
      .bind('无法解密机器人凭据；如果已轮换 AUTOMATION_SECRET，请解除绑定后重新绑定。保活不受影响。', bot.webhook_hash).run();
    return;
  }
  const accounts = await db.prepare('SELECT * FROM insb_accounts WHERE enabled=1 AND deleted_at IS NULL ORDER BY id').all<AccountRow>();
  const offset = tick % Math.max(accounts.results.length, 1);
  const ordered = [...accounts.results.slice(offset), ...accounts.results.slice(0, offset)];
  const activeAccounts = new Set(accounts.results.map(account => account.id));
  const seen = new Set<string>();
  const missing: { account: AccountRow; machineId: string }[] = [];
  let failure = '';
  const observe = async (account: AccountRow, machine: { id: string; name: string; state: string }) => {
    const previous = await db.prepare('SELECT * FROM insb_machine_watch WHERE machine_id=?').bind(machine.id).first<WatchRow>();
    if (!previous) {
      await db.prepare('INSERT OR IGNORE INTO insb_machine_watch (machine_id,account_id,state) VALUES (?,?,?)').bind(machine.id, account.id, machine.state).run();
      return;
    }
    if (!activeAccounts.has(previous.account_id))
      await db.prepare('UPDATE insb_machine_watch SET account_id=? WHERE machine_id=?').bind(account.id, machine.id).run();
    let pendingText = previous.pending_text;
    if (['suspended', 'stopped', 'error', 'deleted'].includes(machine.state) && previous.state === 'running' && !pendingText) {
      pendingText = '机器离线\n' + label(account.label) + ' / ' + label(machine.name) + '\n状态：' + (stateLabels[machine.state as keyof typeof stateLabels] || machine.state) + '\n/status ' + account.id + ' ' + machine.id;
      await db.prepare('UPDATE insb_machine_watch SET state=?,pending_text=? WHERE machine_id=?').bind(machine.state, pendingText, machine.id).run();
    }
    if (pendingText) {
      const current = await botRow(db);
      if (!current?.notify_offline || current.webhook_hash !== bot.webhook_hash) return;
      await telegram.send(bot.chat_id, pendingText + (machine.state === 'running' ? '\n当前已恢复运行。' : ''));
      await db.prepare('UPDATE insb_machine_watch SET pending_text=NULL WHERE machine_id=?').bind(machine.id).run();
    }
    if (machine.state === 'running' && previous.state !== 'running')
      await db.prepare("UPDATE insb_machine_watch SET state='running' WHERE machine_id=?").bind(machine.id).run();
  };
  for (const account of ordered) {
    try {
      const remote = new Instabox(await decryptKey(account.key_ciphertext, account.key_iv, dataKey, account.id), fetcher);
      const machines = await remote.list();
      const watched = await db.prepare('SELECT * FROM insb_machine_watch WHERE account_id=?').bind(account.id).all<WatchRow>();
      const present = new Set(machines.map(machine => machine.id));
      for (const previous of watched.results) if (!present.has(previous.machine_id)) missing.push({ account, machineId: previous.machine_id });
      for (const machine of machines) {
        if (seen.has(machine.id)) continue;
        seen.add(machine.id);
        await observe(account, machine);
      }
    } catch (error) {
      failure = error instanceof PanelError ? error.message : '离线检测未完成，将在下次定时任务重试。';
      if (error instanceof PanelError && error.code === 'automation_budget') break;
    }
  }
  if (!failure) {
    try {
      for (const candidate of missing) {
        if (seen.has(candidate.machineId)) continue;
        seen.add(candidate.machineId);
        await observe(candidate.account, { id: candidate.machineId, name: candidate.machineId, state: 'deleted' });
      }
    } catch (error) { failure = error instanceof PanelError ? error.message : '离线通知发送未完成，将在下次重试。'; }
  }
  await db.prepare('UPDATE insb_telegram SET last_error=? WHERE id=1 AND webhook_hash=? AND last_error<>?').bind(failure, bot.webhook_hash, failure).run();
}
