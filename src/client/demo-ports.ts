import type { Account, Machine } from '../shared/types';
import { portInputError, maxPublicPorts, type PublicPort } from '../shared/ports';
import { ApiError } from './api';

const portsByMachine = new Map<string, PublicPort[]>();
export function demoPorts(path: string, method: string, body: Record<string, any> | undefined, accounts: Account[], machines: Record<string, Machine[]>): unknown {
  const match = path.match(/^\/api\/accounts\/([^/]+)\/machines\/([^/]+)\/ports(?:\/(\d+))?$/);
  if (!match) return undefined;
  const [, accountId, machineId, portNumber] = match;
  if (!accounts.some(a => a.id === accountId && a.enabled)) throw new ApiError('account_disabled', '账号不存在或已停用。', 409);
  if (!machines[accountId]?.some(m => m.id === machineId)) throw new ApiError('not_found', '机器不存在。', 404);
  let ports = portsByMachine.get(machineId);
  if (!ports) { ports = []; portsByMachine.set(machineId, ports); }
  if (method === 'GET' && !portNumber) return structuredClone({ enabled: true, ports });
  if (method === 'POST' && !portNumber) {
    const error = portInputError(body?.port, body?.name);
    if (error) throw new ApiError('invalid_public_port', error, 400);
    let port = ports.find(p => p.port === body!.port);
    if (port) port.name = body!.name;
    else {
      if (ports.length >= maxPublicPorts) throw new ApiError('quota_exceeded', '每台最多公开 16 个端口。', 429);
      const id = 'demo-' + crypto.randomUUID();
      port = { id, machineId, port: body!.port, name: body!.name, url: 'https://' + id + '.example.invalid', createdAt: new Date().toISOString() };
      ports.push(port); ports.sort((a, b) => a.port - b.port);
    }
    return structuredClone({ port });
  }
  if (method === 'DELETE' && portNumber) {
    const port = ports.find(p => p.port === Number(portNumber));
    if (body?.confirmPort !== Number(portNumber)) throw new ApiError('port_confirmation_required', '请确认要取消转发的端口。', 400);
    if (port && port.id !== body?.portId) throw new ApiError('port_changed', '端口已重新发布，请刷新后重试。', 409);
    portsByMachine.set(machineId, ports.filter(p => p !== port));
    return { ok: true };
  }
  throw new ApiError('not_found', '接口不存在。', 404);
}
