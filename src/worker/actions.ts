import { type ActionRow } from './db';
import type { ActionType, Machine } from '../shared/types';
import { PanelError, safeUpstreamMessage } from './errors';
import { machineView, type UpstreamOperation } from './instabox';

export async function createAction(db: D1Database, accountId: string, machine: Machine, type: ActionType, requestId: string) {
  const timestamp = new Date().toISOString();
  const inserted = await db.prepare(`INSERT OR IGNORE INTO insb_actions
    (id,account_id,machine_id,machine_name,type,state,created_at,updated_at)
    SELECT ?,a.id,?,?,?,'submitting',?,? FROM insb_accounts a
    WHERE a.id=? AND a.enabled=1 AND a.deleted_at IS NULL AND NOT EXISTS
    (SELECT id FROM insb_actions WHERE machine_id=? AND state IN ('submitting','queued','running','unknown'))`)
    .bind(requestId, machine.id, machine.name, type, timestamp, timestamp, accountId, machine.id).run();
  const action = await db.prepare('SELECT * FROM insb_actions WHERE id=?').bind(requestId).first<ActionRow>();
  if (!action) throw new PanelError(409, 'pending_actions', '机器仍有未完成或结果待确认的操作，或账号已停用，请检查状态后重试。');
  if (action.account_id !== accountId || action.machine_id !== machine.id || action.type !== type)
    throw new PanelError(409, 'idempotency_conflict', '请求标识已经用于另一个操作。');
  return { action, created: Boolean(inserted.meta.changes) };
}

export async function applyOperation(db: D1Database, row: ActionRow, operation: UpstreamOperation) {
  if (operation.machineId !== row.machine_id || operation.type !== row.type)
    throw new PanelError(502, 'operation_mismatch', '上游操作与请求不一致，结果尚未确认。');
  const machine = operation.machine ? machineView(operation.machine) : undefined;
  const rawCode = operation.error?.code;
  const code = typeof rawCode === 'string' && /^[a-z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'operation_failed';
  await db.prepare(
    'UPDATE insb_actions SET operation_id = ?, state = ?, phase = ?, error_code = ?, error_message = ?, processes_preserved = ?, updated_at = ? WHERE id = ? AND state NOT IN (?, ?)'
  ).bind(operation.id, operation.state, String(operation.phase || '').slice(0, 120),
    operation.state === 'failed' ? code : null, operation.state === 'failed' ? safeUpstreamMessage(code) : null,
    machine?.runtime.processesPreserved === undefined ? null : Number(machine.runtime.processesPreserved),
    new Date().toISOString(), row.id, 'succeeded', 'failed').run();
}
