import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createApp, type Env } from '../src/worker/app';
import type { Fetcher } from '../src/worker/instabox';

const origin='https://panel.test',headers={Origin:origin,'Content-Type':'application/json','X-Panel-Request':'1'};
const machine=(id:string,state='running')=>({id,name:id,state,orgId:'org_test',operationId:null,spec:{vcpus:4,memMiB:8192},runtime:{ready:true}});
test('desktop state and durable snapshot requests use authenticated, isolated platform operations',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-19',d1Databases:['DB']}));
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const libraries=new Map<string,Map<string,any>>(),idempotent=new Map<string,any>();let effects=0,loseCreate=false,loseDelete=false,unsafeHost=false,denyRead=false;
  let state={installed:true,installing:false,running:true,failed:false,agentPausable:true,controller:'agent',yours:false,actions:[] as any[],controlError:''};
  const calls:{path:string;method:string;headers:Headers;body:any}[]=[];
  const fetcher:Fetcher=async(input,init={})=>{
    const url=new URL(String(input)),h=new Headers(init.headers),key=h.get('X-API-Key')||'',method=init.method||'GET',body=init.body?JSON.parse(String(init.body)):{};
    assert.ok(!h.has('Cookie')&&!h.has('Origin')&&!h.has('Cf-Access-Jwt-Assertion'));
    calls.push({path:url.pathname,method,headers:h,body});
    if(url.pathname.endsWith('/desktop/watch')){assert.equal(url.hostname,'access.instabox.sh');assert.equal(h.get('Authorization'),'Bearer refreshed-ticket');assert.equal(key,'');return new Response('event: status\ndata: '+JSON.stringify(state)+'\n\nevent: stale\ndata: {"message":"private error"}\n\n',{headers:{'Content-Type':'text/event-stream'}});}
    assert.equal(url.origin,'https://api.instabox.sh');assert.ok(key.startsWith('ibk_resources_'));
    if(!libraries.has(key))libraries.set(key,new Map());const library=libraries.get(key)!;
    if(url.pathname==='/v1/me')return Response.json({userId:key.endsWith('_b')?2:1,login:key.endsWith('_b')?'b':'a'});
    if(url.pathname==='/v1/machines')return Response.json({machines:[machine('m_live'),machine('m_stopped','stopped'),machine('m_paused','suspended')],nextCursor:null});
    if(/^\/v1\/machines\/[^/]+$/.test(url.pathname))return Response.json(machine(url.pathname.split('/').at(-1)!,url.pathname.endsWith('m_paused')?'suspended':url.pathname.endsWith('m_stopped')?'stopped':'running'));
    if(url.pathname.endsWith('/access'))return Response.json({url:(unsafeHost?'https://evil.invalid':'https://access.instabox.sh')+'/v1/machines/m_live/vnc',watchUrl:'https://access.instabox.sh/v1/machines/m_live/desktop/watch',token:body.requireTicket?'refreshed-ticket':'private-admission-ticket',protocol:'instabox-access.v1',expiresAt:new Date(Date.now()+60000).toISOString()});
    if(url.pathname.endsWith('/desktop')){if(body.action==='takeover'){state.controller='human';state.yours=true;}if(body.action==='handback'){state.controller='agent';state.yours=false;}return Response.json(state);}
    if(url.pathname==='/v1/snapshots')return denyRead?Response.json({error:{code:'insufficient_scope',message:key}},{status:403}):Response.json({snapshots:[...library.values()]});
    if(url.pathname.endsWith('/snapshots')&&method==='POST') {
      const id=h.get('Idempotency-Key')!;assert.match(id,/^panel-snapshot-/);if(idempotent.has(id))return Response.json(idempotent.get(id),{status:202});
      effects++;const snap={id:'sn_'+effects,name:body.name,description:body.description,sourceMachineId:url.pathname.split('/')[3],orgId:'org_test',status:url.pathname.includes('m_stopped')?'ready':'pending',rootSizeBytes:200,createdAt:new Date().toISOString(),...(body.rootOnly?{}:{dataSizeBytes:100})};library.set(snap.id,snap);idempotent.set(id,snap);
      if(loseCreate){loseCreate=false;throw new Error('response lost');}return Response.json(snap,{status:snap.status==='pending'?202:201});
    }
    if(url.pathname.startsWith('/v1/snapshots/')) {
      const id=url.pathname.split('/')[3],snap=library.get(id);if(!snap)return Response.json({error:{code:'not_found'}},{status:404});
      if(method==='DELETE'){assert.equal(h.get('X-Confirm-Delete'),id);assert.match(h.get('Idempotency-Key')!,/^panel-snapshot-/);library.delete(id);if(loseDelete){loseDelete=false;throw new Error('delete response lost');}return new Response(null,{status:204});}
      return Response.json(snap);
    }
    throw new Error('Unhandled '+url.pathname);
  };
  const app=createApp({fetcher}),env={DB:db} as Env;
  async function call(path:string,method='GET',body?:any,cookieValue=cookie){const response=await app.fetch(new Request(origin+path,{method,headers:{...headers,...(cookieValue?{Cookie:cookieValue}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);return{status:response.status,body:await response.json() as any};}
  let cookie='';
  try{
    const setup=await app.fetch(new Request(origin+'/api/auth/setup',{method:'POST',headers,body:JSON.stringify({username:'resource-admin',password:'resource-test-password'})}),env);assert.equal(setup.status,201);cookie=setup.headers.get('Set-Cookie')!.split(';')[0];
    const a=(await call('/api/accounts','POST',{label:'A',apiKey:'ibk_resources_a'})).body.account,b=(await call('/api/accounts','POST',{label:'B',apiKey:'ibk_resources_b'})).body.account;
    const base='/api/accounts/'+a.id,desktop=base+'/machines/m_live/desktop';
    await t.test('desktop authentication, control guard and sanitized state',async()=>{
      assert.equal((await call(desktop,'GET',undefined,'')).status,401);
      state.controlError='ibk_resources_a';state.actions=[{time:'now',tool:'type_text',args:{text:'ibk_resources_a'},refused:true}];
      const result=await call(desktop);assert.equal(JSON.stringify(result).includes('ibk_resources_a'),false);assert.equal(result.body.actions[0].refused,true);
      assert.equal((await call(desktop,'POST',{action:'takeover'})).status,409);state.controlError='';state.agentPausable=false;
      assert.equal((await call(desktop,'POST',{action:'takeover'})).status,409);state.agentPausable=true;
      assert.equal((await call(desktop,'POST',{action:'takeover'})).body.yours,true);assert.equal((await call(desktop,'POST',{action:'handback'})).body.controller,'agent');
      assert.equal((await call(desktop,'POST',{action:'delete'})).status,400);
      const denied=await app.fetch(new Request(origin+desktop,{method:'POST',headers:{...headers,Origin:'https://evil.test',Cookie:cookie},body:'{"action":"takeover"}'}),env);assert.equal(denied.status,403);
    });
    await t.test('access tickets are sealed and bound to account/machine; watch uses refreshed token at the original host',async()=>{
      const result=await call(desktop+'/connection','POST',{});assert.equal(result.status,200);assert.equal(JSON.stringify(result).includes('private-admission-ticket'),false);
      const handle=result.body.connection;
      const wrong=await call('/api/accounts/'+b.id+'/machines/m_live/desktop/watch?connection='+handle);assert.equal(wrong.status,400);
      const response=await app.fetch(new Request(origin+desktop+'/watch?connection='+handle,{headers:{...headers,Cookie:cookie}}),env);
      const text=await response.text();assert.match(text,/event: status/);assert.match(text,/event: stale/);assert.equal(text.includes('private error'),false);assert.equal(text.includes('args'),false);
      unsafeHost=true;assert.equal((await call(desktop+'/connection','POST',{})).status,502);unsafeHost=false;
    });
    await t.test('stopped and live snapshots, range selection and pending completion',async()=>{
      const stopped=await call(base+'/machines/m_stopped/snapshots','POST',{requestId:crypto.randomUUID(),name:'stopped-backup',rootOnly:true});assert.equal(stopped.body.request.state,'succeeded');
      const live=await call(base+'/machines/m_live/snapshots','POST',{requestId:crypto.randomUUID(),name:'live-backup',description:'test'});assert.equal(live.body.request.state,'pending');
      let list=(await call(base+'/snapshots')).body;assert.equal(list.snapshots.find((s:any)=>s.name==='stopped-backup').dataSizeBytes,null);
      libraries.get('ibk_resources_a')!.get(live.body.request.snapshotId).status='ready';list=(await call(base+'/snapshots')).body;
      assert.equal(list.requests.find((r:any)=>r.id===live.body.request.id).state,'succeeded');
      assert.equal((await call(base+'/machines/m_paused/snapshots','POST',{requestId:crypto.randomUUID(),name:'paused-backup'})).status,409);
      assert.equal((await call(base+'/machines/m_live/snapshots','POST',{requestId:crypto.randomUUID(),name:'INVALID NAME'})).status,400);
    });
    await t.test('lost create responses retry the persisted request without a second snapshot and reject payload/account reuse',async()=>{
      const id=crypto.randomUUID(),path=base+'/machines/m_live/snapshots',body={requestId:id,name:'lost-create'};loseCreate=true;
      assert.equal((await call(path,'POST',body)).body.request.state,'unknown');const before=effects;
      assert.equal((await call(path,'POST',{...body,name:'different'})).status,409);
      assert.equal((await call('/api/accounts/'+b.id+'/snapshot-requests/'+id+'/retry','POST',{})).status,404);
      const retry=await call(base+'/snapshot-requests/'+id+'/retry','POST',{});assert.equal(retry.body.request.state,'pending');assert.equal(effects,before);
      libraries.get('ibk_resources_a')!.get(retry.body.request.snapshotId).status='ready';await call(base+'/snapshots');
    });
    await t.test('deleting requires the exact name, handles 204 and lost replies, and isolates accounts',async()=>{
      const snap=[...libraries.get('ibk_resources_a')!.values()][0],id=crypto.randomUUID(),path=base+'/snapshots/'+snap.id;
      assert.equal((await call(path,'DELETE',{requestId:id,confirmName:'wrong'})).status,409);
      assert.equal((await call('/api/accounts/'+b.id+'/snapshots/'+snap.id,'DELETE',{requestId:crypto.randomUUID(),confirmName:snap.name})).status,404);
      loseDelete=true;assert.equal((await call(path,'DELETE',{requestId:id,confirmName:snap.name})).body.request.state,'unknown');
      assert.equal((await call(base+'/snapshot-requests/'+id+'/retry','POST',{})).body.request.state,'succeeded');
      const next=[...libraries.get('ibk_resources_a')!.values()][0];assert.equal((await call(base+'/snapshots/'+next.id,'DELETE',{requestId:crypto.randomUUID(),confirmName:next.name})).body.request.state,'succeeded');
    });
    await t.test('permissions explain image scopes and unresolved snapshots protect account credentials',async()=>{
      denyRead=true;const denied=await call(base+'/snapshots');assert.equal(denied.status,422);assert.match(denied.body.error.message,/images:read/);assert.equal(JSON.stringify(denied).includes('ibk_resources_a'),false);denyRead=false;
      const request=(await call(base+'/machines/m_live/snapshots','POST',{requestId:crypto.randomUUID(),name:'pending-final'})).body.request;
      assert.equal((await call(base,'DELETE',{})).status,409);
      libraries.get('ibk_resources_a')!.delete(request.snapshotId);const refreshed=(await call(base+'/snapshots')).body;
      assert.equal(refreshed.requests.find((r:any)=>r.id===request.id).state,'failed');assert.equal((await call(base,'DELETE',{})).status,200);
    });
  }finally{await mf.dispose();}
});

test('real Workers VNC proxy carries binary RFB bytes without browser credentials or upstream subprotocol leakage',async()=>{
  const bundle=await build({stdin:{contents:'import {createApp} from "./src/worker/app.ts";export default createApp();',resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const upstream=String.raw`export default {async fetch(request){const u=new URL(request.url);if(request.headers.has('Cookie')||request.headers.has('Origin'))return new Response('leak',{status:500});
    if(u.pathname.endsWith('/vnc')){if(request.headers.get('Sec-WebSocket-Protocol')!=='instabox-access.v1, instabox-access-token.access-test-token'||request.headers.has('X-API-Key'))return new Response('bad auth',{status:403});const p=new WebSocketPair();p[1].binaryType="arraybuffer";p[1].accept();p[1].addEventListener('message',e=>p[1].send(e.data));p[1].send(new TextEncoder().encode('RFB 003.008\n'));return new Response(null,{status:101,webSocket:p[0],headers:{'Sec-WebSocket-Protocol':'instabox-access.v1'}});}
    if(request.headers.get('X-API-Key')!=='ibk_vnc_fixture')return new Response('bad key',{status:401});
    if(u.pathname==='/v1/me')return Response.json({userId:10});if(u.pathname==='/v1/machines')return Response.json({machines:[],nextCursor:null});
    if(u.pathname.endsWith('/access'))return Response.json({url:'https://access.instabox.sh/v1/machines/m_vnc/vnc',watchUrl:'https://access.instabox.sh/v1/machines/m_vnc/desktop/watch',protocol:'instabox-access.v1',token:'access-test-token',expiresAt:new Date(Date.now()+60000).toISOString()});return new Response('not found',{status:404});}}`;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'panel',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-19',d1Databases:['DB'],outboundService:'upstream'},{name:'upstream',modules:true,script:upstream,compatibilityDate:'2026-10-19'}]}));
  try{
    const setup=await mf.dispatchFetch(origin+'/api/auth/setup',{method:'POST',headers,body:JSON.stringify({username:'vnc-admin',password:'test-vnc-password'})});assert.equal(setup.status,201);const cookie=setup.headers.get('Set-Cookie')!.split(';')[0];
    const account=await mf.dispatchFetch(origin+'/api/accounts',{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify({label:'VNC',apiKey:'ibk_vnc_fixture'})}).then(r=>r.json()) as any;
    const base=origin+'/api/accounts/'+account.account.id+'/machines/m_vnc/desktop';
    const ticket=await mf.dispatchFetch(base+'/connection',{method:'POST',headers:{...headers,Cookie:cookie},body:'{}'}).then(r=>r.json()) as any;
    const url=base+'/vnc?connection='+ticket.connection;
    assert.equal((await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:origin}})).status,401);
    assert.equal((await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:'https://evil.test',Cookie:cookie}})).status,403);
    const response=await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:origin,Cookie:cookie}});assert.equal(response.status,101);assert.equal(response.headers.has('Sec-WebSocket-Protocol'),false);
    const ws=response.webSocket!;const next=()=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('VNC timeout')),5000);ws.addEventListener('message',e=>{clearTimeout(timer);resolve(e.data);},{once:true});});
    let message=next();ws.accept();assert.equal(new TextDecoder().decode(await message),'RFB 003.008\n');message=next();const bytes=new Uint8Array([0,255,1,2,0,3]);ws.send(bytes);assert.deepEqual(new Uint8Array(await message),bytes);ws.close();
  }finally{await mf.dispose();}
});
