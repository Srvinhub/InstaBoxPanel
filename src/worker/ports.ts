import { maxPublicPorts, portInputError, publicPortUrl, type PublicPort, type PublicPortOverview } from '../shared/ports';
import { PanelError } from './errors';
import type { Instabox } from './instabox';
import { resourceBody, resourceId, type ResourceAccess, type ResourceApp, type ResourceContext } from './resource-context';

function malformed(): never {
  throw new PanelError(502, 'invalid_port_response', 'InstaBox 返回的端口数据不完整，请刷新后重试。');
}

function portView(raw: any, machineId: string): PublicPort {
  if (!raw || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) || raw.machineId !== machineId ||
      portInputError(raw.port, raw.name) || typeof raw.url !== 'string' || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) malformed();
  // Only return display fields; never turn an upstream value into an executable link.
  return { id: raw.id, machineId, port: raw.port, name: raw.name, url: publicPortUrl(raw.url), createdAt: raw.createdAt };
}

async function request(remote: Instabox, path: string, init?: RequestInit): Promise<any> {
  try { return await remote.request(path, init); }
  catch (error) {
    if (error instanceof PanelError) {
      if (error.code === 'insufficient_scope')
        throw new PanelError(422, error.code, '查看端口需要 machines:read，发布、改名和取消转发需要 machines:write；请在账号设置中替换 Key。');
      if (error.status === 429)
        throw new PanelError(429, error.code, '端口额度或请求频率受限；每台机器最多公开 16 个端口，请刷新列表后稍后重试。', true);
      if (error.status === 503)
        throw new PanelError(503, error.code, 'InstaBox 公网端口服务暂不可用，请稍后刷新。', true);
      if (error.status === 400)
        throw new PanelError(400, error.code, '端口或名称不被平台接受，请检查端口范围、平台保留端口和名称长度。');
    }
    throw error;
  }
}

async function overview(remote: Instabox, path: string, machineId: string): Promise<PublicPortOverview> {
  const raw = await request(remote, path);
  if (!raw || typeof raw.enabled !== 'boolean' || !Array.isArray(raw.ports) || raw.ports.length > maxPublicPorts) malformed();
  const ports = raw.ports.map((p: unknown) => portView(p, machineId)) as PublicPort[];
  if (new Set(ports.map(p => p.port)).size !== ports.length || new Set(ports.map(p => p.id)).size !== ports.length) malformed();
  return { enabled: raw.enabled, ports: ports.sort((a, b) => a.port - b.port) };
}

export function registerPortRoutes(app: ResourceApp, access: ResourceAccess) {
  const route = '/api/accounts/:id/machines/:machineId/ports';
  async function context(c: ResourceContext) {
    const machineId = resourceId(c.req.param('machineId'));
    const account = await access.account(c.env.DB, resourceId(c.req.param('id')));
    return { machineId, remote: await access.remote(c.get('identity'), account), path: '/v1/machines/' + encodeURIComponent(machineId) + '/ports' };
  }
  app.get(route, async c => {
    const { remote, path, machineId } = await context(c);
    return c.json(await overview(remote, path, machineId));
  });
  app.post(route, async c => {
    const body = await resourceBody(c);
    const error = portInputError(body.port, body.name);
    if (error) throw new PanelError(400, 'invalid_public_port', error);
    const { remote, path, machineId } = await context(c);
    const port = portView(await request(remote, path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: body.port, name: body.name }),
    }), machineId);
    if (port.port !== body.port) malformed();
    return c.json({ port });
  });
  app.delete(route + '/:port', async c => {
    const value = c.req.param('port') || '';
    const port = Number(value);
    if (!/^[1-9][0-9]{3,4}$/.test(value) || portInputError(port, ''))
      throw new PanelError(400, 'invalid_public_port', '端口号无效。');
    const body = await resourceBody(c);
    if (body.confirmPort !== port || typeof body.portId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.portId))
      throw new PanelError(400, 'port_confirmation_required', '请确认要取消转发的端口。');
    const { remote, path, machineId } = await context(c);
    const current = (await overview(remote, path, machineId)).ports.find(p => p.port === port);
    if (!current) return c.json({ ok: true });
    if (current.id !== body.portId)
      throw new PanelError(409, 'port_changed', '这个端口已重新发布，请刷新列表并确认新的转发地址。');
    await request(remote, path + '/' + port, { method: 'DELETE' });
    return c.json({ ok: true });
  });
}
