export class PanelError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false, public retryAfter?: number) {
    super(message);
  }
}
export const upstreamMessages: Record<string, string> = {
  api_key_expired: '这个账号的 API Key 已过期，请替换。',
  api_key_revoked: '这个账号的 API Key 已撤销，请替换。',
  invalid_api_key: 'API Key 无效，请检查后重试。',
  insufficient_scope: 'API Key 权限不足；控制机器需要 machines:write。',
  permission_denied: '这个账号没有执行该操作的权限。',
  invite_required: '请先在 InstaBox 官网完成账号激活。',
  not_found: '机器或操作已不存在，或当前账号无权访问。',
  operation_conflict: '机器正在执行其他操作，请刷新后再试。',
  idempotency_conflict: '请求标识与之前的操作不一致。',
  quota_exceeded: '账号额度不足，请到 InstaBox 查看。',
  no_capacity: 'InstaBox 暂时没有可用容量，请稍后重试。',
  payment_required: '需要处理 InstaBox 账号的付款或额度问题。',
  machine_not_running: '机器当前不在可执行此操作的状态。',
  rate_limited: 'InstaBox 请求频率受限，请稍后重试。',
  desktop_not_running: '桌面尚未运行，请先启动桌面。',
  delete_confirmation_required: '删除确认与快照不匹配，请重新确认。',
  name_taken: '这个名称已被使用，请换一个名称。',
  snapshot_not_ready: '快照尚未就绪，请等待保存完成。',
  live_snapshot_disabled: '此机器不支持实时快照，请停止机器后创建。',
};
export function safeUpstreamMessage(code: string): string {
  return upstreamMessages[code] ?? 'InstaBox 未能完成请求，请稍后重试或到官方控制台查看。';
}
