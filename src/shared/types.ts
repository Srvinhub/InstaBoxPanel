export const machineStates = ['creating', 'starting', 'running', 'stopping', 'stopped', 'suspending', 'suspended', 'resuming', 'deleting', 'deleted', 'error'] as const;
export type MachineState = typeof machineStates[number];
export type ActionType = 'suspend' | 'resume' | 'start' | 'stop';
export type ActionState = 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
export type ActionSource = 'web' | 'telegram' | 'keepalive' | 'unknown';
export interface Account {
  id: string; label: string; userId: string; login: string; email: string;
  keySuffix: string; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface Machine {
  id: string; name: string; orgId: string; state: MachineState;
  operationId: string | null; revision: number; autoSuspendAfterSeconds: number | null;
  autoSuspendedAt?: string; updatedAt: string; createdAt: string;
  spec: { vcpus: number; memMiB: number };
  runtime: { ready: boolean; processesPreserved?: boolean };
}
export interface AccountMachines {
  accountId: string; machines: Machine[]; checkedAt: string;
}
export interface Action {
  id: string; accountId: string; machineId: string; machineName: string;
  type: ActionType; source: ActionSource; state: ActionState; operationId: string | null; phase: string;
  errorCode: string | null; errorMessage: string | null;
  createdAt: string; updatedAt: string; processesPreserved: boolean | null;
}
export interface Session { username: string; authenticated: boolean; setupRequired: boolean; demo: boolean }
export interface ApiErrorBody { error: { code: string; message: string; retryable?: boolean } }
export const stateLabels: Record<MachineState, string> = {
  creating: '创建中', starting: '启动中', running: '运行中', stopping: '停止中',
  stopped: '已停止', suspending: '暂停中', suspended: '已暂停', resuming: '恢复中',
  deleting: '删除中', deleted: '已删除', error: '运行异常',
};
export const actionLabels: Record<ActionType, string> = {
  suspend: '暂停', resume: '恢复', start: '启动', stop: '停止',
};
export const actionSourceLabels: Record<ActionSource, string> = {
  web: '来自 Web', telegram: '来自 TG', keepalive: '来自保活定时器', unknown: '历史记录，来源未记录',
};
