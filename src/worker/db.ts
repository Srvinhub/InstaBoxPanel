import type { Account, Action, ActionSource, ActionState, ActionType } from '../shared/types';
export interface AccountRow {
  id: string; label: string; instabox_user_id: string; login: string; email: string;
  key_ciphertext: string; key_iv: string; key_version: number; key_suffix: string;
  enabled: number; created_at: string; updated_at: string;
}
export interface ActionRow {
  id: string; account_id: string; machine_id: string; machine_name: string; type: ActionType;
  state: ActionState; operation_id: string | null; phase: string;
  error_code: string | null; error_message: string | null; processes_preserved: number | null;
  created_at: string; updated_at: string;
  source?: ActionSource | null;
}
export async function actionRow(db: D1Database, id: string): Promise<ActionRow | null> {
  return db.prepare('SELECT a.*,s.source FROM insb_actions a LEFT JOIN insb_action_sources s ON s.action_id=a.id WHERE a.id=?')
    .bind(id).first<ActionRow>();
}
export function accountView(r: AccountRow): Account {
  return { id: r.id, label: r.label, userId: r.instabox_user_id, login: r.login, email: r.email,
    keySuffix: r.key_suffix, enabled: Boolean(r.enabled), createdAt: r.created_at, updatedAt: r.updated_at };
}
export function actionView(r: ActionRow): Action {
  const staleSubmitting = r.state === 'submitting' && Date.now() - Date.parse(r.updated_at) > 30000;
  return { id: r.id, accountId: r.account_id, machineId: r.machine_id, machineName: r.machine_name,
    type: r.type, source: r.source || 'unknown', state: staleSubmitting ? 'unknown' : r.state, operationId: r.operation_id,
    phase: r.phase, errorCode: r.error_code,
    errorMessage: staleSubmitting ? '请求结果尚未确认，可使用原请求重试。' : r.error_message,
    processesPreserved: r.processes_preserved === null ? null : Boolean(r.processes_preserved),
    createdAt: r.created_at, updatedAt: r.updated_at };
}
