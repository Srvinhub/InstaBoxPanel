import { inKeepaliveWindow, validateSchedule, KEEPALIVE_INTERVAL_MINUTES, KEEPALIVE_MAX_MACHINES, type KeepaliveMode, type KeepalivePolicy, type KeepaliveOverview, type TimeWindow } from '../shared/keepalive';
import { decryptKey } from './crypto';
import { type AccountRow, type ActionRow } from './db';
import { PanelError } from './errors';
import { Instabox, type Fetcher } from './instabox';
import { actionSourceStatement, applyOperation } from './actions';
import { database, ensureDatabase } from './schema';
import { enableAutomation, migrateAutomation, type AutomationEnv } from './automation';

export type KeepaliveEnv = AutomationEnv;
interface PolicyRow {
  machine_id: string; account_id: string; machine_name: string; mode: KeepaliveMode;
  timezone: string; windows_json: string; version: number; action_id: string | null;
  last_checked_at: number | null; last_state: string; last_result: string; last_error: string;
}
const activeStates = ['submitting', 'queued', 'running', 'unknown'];
function view(row: PolicyRow): KeepalivePolicy {
  return { machineId: row.machine_id, accountId: row.account_id, machineName: row.machine_name, mode: row.mode,
    timezone: row.timezone, windows: JSON.parse(row.windows_json) as TimeWindow[],
    lastCheckedAt: row.last_checked_at, lastState: row.last_state, lastResult: row.last_result, lastError: row.last_error };
}
export async function keepaliveOverview(env: KeepaliveEnv, dataKey?: string): Promise<KeepaliveOverview> {
  const db = database(env);
  await ensureDatabase(db);
  if (dataKey) await migrateAutomation(env, dataKey);
  const policies = await db.prepare('SELECT * FROM insb_keepalive ORDER BY machine_name').all<PolicyRow>();
  const scheduler = await db.prepare('SELECT last_run_at FROM insb_scheduler WHERE id=1').first<{ last_run_at: number | null }>();
  return { intervalMinutes: KEEPALIVE_INTERVAL_MINUTES, maxMachines: KEEPALIVE_MAX_MACHINES,
    policies: policies.results.map(view), lastRunAt: scheduler?.last_run_at ?? null };
}
export async function saveKeepalive(env: KeepaliveEnv, account: AccountRow, machineId: string, value: unknown, dataKey: string, fetcher?: Fetcher) {
  const db = database(env);
  await ensureDatabase(db);
  let policy: ReturnType<typeof validateSchedule>;
  try { policy = validateSchedule(value); }
  catch (error) { throw new PanelError(400, 'invalid_keepalive', (error as Error).message); }
  const existing = await db.prepare('SELECT * FROM insb_keepalive WHERE machine_id=?').bind(machineId).first<PolicyRow>();
  if (policy.mode === 'off') {
    if (existing) await db.prepare("UPDATE insb_keepalive SET mode='off',version=version+1,last_error='',last_result='保活已关闭',updated_at=? WHERE machine_id=?")
      .bind(new Date().toISOString(), machineId).run();
    return keepaliveOverview(env);
  }
  if (!account.enabled) throw new PanelError(409, 'account_disabled', '请先启用这个账号。');
  const apiKey = await decryptKey(account.key_ciphertext, account.key_iv, dataKey, account.id);
  const machine = await new Instabox(apiKey, fetcher).machine(machineId);
  if (['deleted', 'deleting'].includes(machine.state)) throw new PanelError(409, 'invalid_state', '已删除的机器不能开启保活。');
  if (existing?.account_id !== account.id && existing?.action_id) {
    const action = await db.prepare('SELECT state FROM insb_actions WHERE id=?').bind(existing.action_id).first<{ state: string }>();
    if (action && activeStates.includes(action.state)) throw new PanelError(409, 'pending_actions', '请先确认原账号的保活任务结果，再切换账号。');
  }
  await enableAutomation(env, dataKey);
  const saved = await db.prepare(`INSERT INTO insb_keepalive
    (machine_id,account_id,machine_name,mode,timezone,windows_json,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM insb_keepalive WHERE mode<>'off' AND machine_id<>?) < ?
    ON CONFLICT(machine_id) DO UPDATE SET account_id=excluded.account_id,machine_name=excluded.machine_name,
      mode=excluded.mode,timezone=excluded.timezone,windows_json=excluded.windows_json,version=insb_keepalive.version+1,
      last_error='',last_result='等待定时检查',updated_at=excluded.updated_at`)
    .bind(machineId, account.id, machine.name, policy.mode, policy.timezone, JSON.stringify(policy.windows),
      new Date().toISOString(), machineId, KEEPALIVE_MAX_MACHINES).run();
  if (!saved.meta.changes) throw new PanelError(409, 'keepalive_limit', '为控制免费额度，最多同时为 5 台机器开启保活。');
  return keepaliveOverview(env);
}
async function stillActive(db: D1Database, row: PolicyRow): Promise<boolean> {
  if (!inKeepaliveWindow(view(row), Date.now())) return false;
  return Boolean(await db.prepare(`SELECT k.machine_id FROM insb_keepalive k JOIN insb_accounts a ON a.id=k.account_id
    WHERE k.machine_id=? AND k.version=? AND k.mode<>'off' AND a.enabled=1 AND a.deleted_at IS NULL`)
    .bind(row.machine_id, row.version).first());
}
async function saveResult(db: D1Database, row: PolicyRow, timestamp: number, state: string, result: string, error = '') {
  await db.prepare('UPDATE insb_keepalive SET last_checked_at=?,last_state=?,last_result=?,last_error=? WHERE machine_id=? AND version=?')
    .bind(timestamp, state, result, error, row.machine_id, row.version).run();
}
async function runPolicy(env: KeepaliveEnv, row: PolicyRow, dataKey: string, fetcher?: Fetcher) {
  const db = env.DB, timestamp = Date.now();
  if (!inKeepaliveWindow(view(row), timestamp)) return;
  let state = '', created = false;
  try {
    const account = await db.prepare('SELECT * FROM insb_accounts WHERE id=? AND enabled=1 AND deleted_at IS NULL').bind(row.account_id).first<AccountRow>();
    if (!account) return;
    const remote = new Instabox(await decryptKey(account.key_ciphertext, account.key_iv, dataKey, account.id), fetcher);
    let action = row.action_id ? await db.prepare('SELECT * FROM insb_actions WHERE id=?').bind(row.action_id).first<ActionRow>() : null;
    if (action && activeStates.includes(action.state)) {
      if (action.operation_id) {
        await applyOperation(db, action, await remote.operation(action.operation_id, 0));
        const current = await db.prepare('SELECT * FROM insb_actions WHERE id=?').bind(action.id).first<ActionRow>();
        await saveResult(db, row, timestamp, '', current?.state === 'succeeded' ? '自动恢复已完成' : current?.state === 'failed' ? '自动恢复失败' : '等待恢复任务完成', current?.error_message || '');
        return;
      }
      if (timestamp - Date.parse(action.created_at) > 6 * 86400000) {
        await saveResult(db, row, timestamp, '', '需要确认', '原恢复请求已超过安全重试期限，请到操作记录确认。');
        return;
      }
    } else {
      const machine = await remote.machine(row.machine_id);
      state = machine.state;
      if (machine.state !== 'suspended' || machine.operationId) {
        await saveResult(db, row, timestamp, state, machine.state === 'running' ? '运行正常' : machine.state === 'stopped' ? '已停止，等待手动启动' : '当前状态无需恢复');
        return;
      }
      if (action?.state === 'failed' && timestamp - Date.parse(action.updated_at) < 300000) {
        await saveResult(db, row, timestamp, state, '恢复失败，5 分钟后重试', action.error_message || '');
        return;
      }
      const pending = await db.prepare("SELECT id FROM insb_actions WHERE machine_id=? AND state IN ('submitting','queued','running','unknown') LIMIT 1").bind(row.machine_id).first();
      if (pending) { await saveResult(db, row, timestamp, state, '等待已有操作确认'); return; }
      if (!await stillActive(db, row)) return;
      const requestId = crypto.randomUUID(), stamp = new Date(timestamp).toISOString();
      const claimed = await db.batch([
        db.prepare(`INSERT INTO insb_actions (id,account_id,machine_id,machine_name,type,state,created_at,updated_at)
          SELECT ?,k.account_id,k.machine_id,k.machine_name,'resume','submitting',?,? FROM insb_keepalive k
          JOIN insb_accounts a ON a.id=k.account_id WHERE k.machine_id=? AND k.version=? AND k.mode<>'off'
          AND a.enabled=1 AND a.deleted_at IS NULL AND NOT EXISTS
          (SELECT id FROM insb_actions WHERE machine_id=k.machine_id AND state IN ('submitting','queued','running','unknown'))`).bind(requestId, stamp, stamp, row.machine_id, row.version),
        actionSourceStatement(db, requestId, 'keepalive'),
        db.prepare('UPDATE insb_keepalive SET action_id=? WHERE machine_id=? AND version=? AND EXISTS(SELECT id FROM insb_actions WHERE id=?)')
          .bind(requestId, row.machine_id, row.version, requestId),
      ]);
      if (!claimed[0].meta.changes) return;
      created = true;
      action = await db.prepare('SELECT * FROM insb_actions WHERE id=?').bind(requestId).first<ActionRow>();
    }
    if (!action) return;
    if (!await stillActive(db, row)) {
      if (created) await db.prepare("UPDATE insb_actions SET state='failed',error_code='policy_changed',error_message='发送前保活配置已变更，请求已取消。',updated_at=? WHERE id=? AND state='submitting'")
        .bind(new Date().toISOString(), action.id).run();
      return;
    }
    try {
      const operation = await remote.change(row.machine_id, 'resume', 'panel-' + action.id);
      await applyOperation(db, action, operation);
      await saveResult(db, row, timestamp, state, operation.state === 'succeeded' ? '自动恢复已完成' : operation.state === 'failed' ? '自动恢复失败' : '已提交自动恢复');
    } catch (error) {
      const failure = error instanceof PanelError ? error : new PanelError(502, 'submission_uncertain', '恢复结果待确认，将复用原请求重试。', true);
      await db.prepare("UPDATE insb_actions SET state=?,error_code=?,error_message=?,updated_at=? WHERE id=? AND state IN ('submitting','unknown')")
        .bind(failure.status >= 500 ? 'unknown' : 'failed', failure.code, failure.message, new Date(timestamp).toISOString(), action.id).run();
      throw failure;
    }
  } catch (error) {
    await saveResult(db, row, timestamp, state, '检查未完成', error instanceof PanelError ? error.message : '保活检查失败，请检查配置后重试。');
  }
}
export async function checkKeepalive(env: KeepaliveEnv, dataKey: string, fetcher?: Fetcher) {
  const policies = await env.DB.prepare(`SELECT k.* FROM insb_keepalive k JOIN insb_accounts a ON a.id=k.account_id
    WHERE k.mode<>'off' AND a.enabled=1 AND a.deleted_at IS NULL ORDER BY k.machine_id LIMIT ?`)
    .bind(KEEPALIVE_MAX_MACHINES).all<PolicyRow>();
  for (let offset = 0; offset < policies.results.length; offset += 3)
    await Promise.all(policies.results.slice(offset, offset + 3).map(row => runPolicy(env, row, dataKey, fetcher)));
}
