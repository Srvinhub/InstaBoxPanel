import type { DesktopState } from '../shared/resources';
import { encryptKey, decryptKey } from './crypto';
import { PanelError, safeUpstreamMessage } from './errors';
import type { ResourceAccess, ResourceApp, ResourceContext } from './resource-context';
import { resourceId, resourceBody } from './resource-context';

export function desktopView(raw: any): DesktopState {
  if (!raw || ['installed','installing','running','failed','agentPausable'].some(key => typeof raw[key] !== 'boolean'))
    throw new PanelError(502, 'invalid_desktop', '桌面状态不完整，请重试。');
  return { installed: raw.installed, installing: raw.installing, running: raw.running, failed: raw.failed,
    agentPausable: raw.agentPausable, controller: raw.controller === 'human' ? 'human' : 'agent', yours: raw.yours === true,
    controlError: raw.controlError ? '平台无法更新控制权，请检查桌面服务。' : '',
    actions: (Array.isArray(raw.actions) ? raw.actions : []).slice(-20).map((action: any) => ({
      time: typeof action?.time === 'string' ? action.time : '', tool: typeof action?.tool === 'string' ? action.tool.slice(0,100) : '操作', refused: action?.refused === true,
    })) };
}
interface Connection { url: string; watchUrl: string; token?: string; protocol?: string; createdAt: number; expiresAt: number }
function trustedUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new PanelError(502, 'invalid_access_url', '平台返回了无效的桌面接入地址。'); }
  if (!['https:','wss:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !(url.hostname === 'instabox.sh' || url.hostname.endsWith('.instabox.sh')))
    throw new PanelError(502, 'invalid_access_url', '平台桌面接入域名未受信任。');
  url.protocol = 'https:'; return url.href;
}
async function upstreamError(response: Response): Promise<never> {
  const data = await response.json().catch(() => null) as any;
  const code = typeof data?.error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(data.error.code) ? data.error.code : 'desktop_unavailable';
  throw new PanelError(response.status >= 400 && response.status < 600 ? response.status : 502, code, safeUpstreamMessage(code), true);
}
export function registerDesktopRoutes(app: ResourceApp, access: ResourceAccess) {
  async function context(c: ResourceContext) {
    const row = await access.account(c.env.DB, resourceId(c.req.param('id')));
    const machineId = resourceId(c.req.param('machineId'));
    const identity = c.get('identity');
    return { row, machineId, identity, remote: await access.remote(identity, row), path: '/v1/machines/' + encodeURIComponent(machineId),
      binding: `desktop:${row.id}:${machineId}:${identity.sessionHash || identity.username}` };
  }
  app.get('/api/accounts/:id/machines/:machineId/desktop', async c => {
    const { remote, path } = await context(c);
    return c.json(desktopView(await remote.request(path + '/desktop', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action:'status'}) })));
  });
  app.post('/api/accounts/:id/machines/:machineId/desktop', async c => {
    const { remote, path } = await context(c), body = await resourceBody(c);
    if (!['install','start','takeover','handback'].includes(String(body.action))) throw new PanelError(400, 'invalid_desktop_action', '桌面操作无效。');
    if (body.action === 'takeover') {
      const state = desktopView(await remote.request(path + '/desktop', {method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"status"}'}));
      if (!state.running || !state.agentPausable || state.controlError) throw new PanelError(409, 'desktop_watch_only', '当前桌面无法安全暂停 AI 输入，仅可观看。');
    }
    return c.json(desktopView(await remote.request(path + '/desktop', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:body.action})}, 30000)));
  });
  app.post('/api/accounts/:id/machines/:machineId/desktop/connection', async c => {
    const { remote, path, binding, identity } = await context(c);
    const ticket = await remote.request(path + '/access', {method:'POST',headers:{'Content-Type':'application/json'},body:'{"kind":"vnc"}'});
    if(!ticket||typeof ticket!=='object')throw new PanelError(502,'invalid_access_ticket','平台桌面接入信息不完整。');
    const token = typeof ticket?.token === 'string' && ticket.token ? ticket.token : undefined;
    if (token && (token.length > 8192 || !/^[A-Za-z0-9._~-]+$/.test(token) || typeof ticket.protocol !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(ticket.protocol)))
      throw new PanelError(502, 'invalid_access_ticket', '平台桌面票据无效。');
    const connection: Connection = { url: token ? trustedUrl(ticket.url) : 'https://api.instabox.sh' + path + '/vnc',
      watchUrl: token ? trustedUrl(ticket.watchUrl) : 'https://api.instabox.sh' + path + '/desktop/watch',
      token, protocol: token ? ticket.protocol : undefined, createdAt: Date.now(), expiresAt: Math.min(Date.now()+60000, Date.parse(ticket.expiresAt) || Date.now()+60000) };
    const sealed = await encryptKey(JSON.stringify(connection), identity.key, binding);
    return c.json({ connection: btoa(JSON.stringify(sealed)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'') });
  });
  async function connection(c: ResourceContext, forWatch = false) {
    const ctx = await context(c), handle = c.req.query('connection');
    let data: Connection;
    try {
      if (!handle || handle.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(handle)) throw new Error();
      const sealed = JSON.parse(atob(handle.replaceAll('-','+').replaceAll('_','/')));
      data = JSON.parse(await decryptKey(sealed.ciphertext, sealed.iv, ctx.identity.key, ctx.binding));
      if (!Number.isFinite(data.createdAt) || Date.now()-data.createdAt > 12*3600000 || (!forWatch && Date.now()>data.expiresAt)) throw new Error();
      trustedUrl(data.url); trustedUrl(data.watchUrl);
    } catch { throw new PanelError(400, 'desktop_connection_expired', '桌面连接信息已失效，请重新连接。'); }
    return { ...ctx, data };
  }
  app.get('/api/accounts/:id/machines/:machineId/desktop/vnc', async c => {
    if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new PanelError(403, 'csrf_rejected', '桌面连接来源无效。');
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') throw new PanelError(426, 'websocket_required', '桌面需要 WebSocket 连接。');
    const { data, row, identity } = await connection(c);
    const headers: Record<string,string> = {Upgrade:'websocket'};
    if (data.token) headers['Sec-WebSocket-Protocol'] = `${data.protocol}, instabox-access-token.${data.token}`;
    else headers['X-API-Key'] = await decryptKey(row.key_ciphertext,row.key_iv,identity.key,row.id);
    let response: Response;
    try { response = await (access.fetcher || fetch)(data.url, {headers,redirect:'manual',signal:AbortSignal.timeout(15000)}); }
    catch { throw new PanelError(502,'desktop_unavailable','无法连接桌面，请检查机器状态后重试。',true); }
    if (response.status !== 101 || !response.webSocket) await upstreamError(response);
    return new Response(null,{status:101,webSocket:response.webSocket});
  });
  app.get('/api/accounts/:id/machines/:machineId/desktop/watch', async c => {
    const { data, remote, path, row, identity } = await connection(c,true);
    const headers: Record<string,string> = {Accept:'text/event-stream'};
    if (data.token) {
      // Refresh admission without moving an established watch to a newly routed access host.
      const ticket = await remote.request(path+'/access',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"kind":"vnc","requireTicket":true}'});
      if (typeof ticket?.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(ticket.token)) throw new PanelError(502,'invalid_access_ticket','无法刷新桌面状态票据。');
      headers.Authorization = 'Bearer '+ticket.token;
    } else headers['X-API-Key'] = await decryptKey(row.key_ciphertext,row.key_iv,identity.key,row.id);
    let upstream: Response;
    try { upstream = await (access.fetcher || fetch)(data.watchUrl,{headers,redirect:'manual',signal:c.req.raw.signal}); }
    catch { throw new PanelError(502,'desktop_watch_unavailable','无法读取桌面状态。',true); }
    if (!upstream.ok || !upstream.headers.get('Content-Type')?.includes('text/event-stream') || !upstream.body) await upstreamError(upstream);
    const reader = upstream.body!.getReader(), encoder = new TextEncoder(), decoder = new TextDecoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          let buffer = '';
          try {
            while (!cancelled) {
              const {value,done} = await reader.read(); if(done) break;
              buffer = (buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');
              if(buffer.length>131072) throw new Error('oversized event');
              let end: number;
              while ((end=buffer.indexOf('\n\n'))>=0) {
                const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
                const kind=event.match(/^event:\s*(\w+)/m)?.[1];
                if(kind==='status') {
                  const text=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
                  controller.enqueue(encoder.encode('event: status\ndata: '+JSON.stringify(desktopView(JSON.parse(text)))+'\n\n'));
                } else if(kind==='stale'||kind==='end') controller.enqueue(encoder.encode(`event: ${kind}\ndata: {}\n\n`));
                else controller.enqueue(encoder.encode(': keepalive\n\n'));
              }
            }
            if(!cancelled) controller.close();
          } catch { if(!cancelled) controller.error(new Error('Desktop status disconnected')); }
          finally { await reader.cancel().catch(()=>{}); }
        })();
      },
      cancel() { cancelled=true; return reader.cancel(); },
    });
    return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  });
}
