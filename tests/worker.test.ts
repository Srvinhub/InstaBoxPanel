import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createApp, type Env } from '../src/worker/app';
import type { Fetcher } from '../src/worker/instabox';

const secret=Buffer.alloc(32,9).toString('base64');
const base='https://panel.test';
const originHeaders={'Origin':base,'Content-Type':'application/json','X-Panel-Request':'1'};
async function migrate(db:D1Database){
  const sql=await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
}
const machine=(id:string,state='suspended')=>({id,name:id,orgId:'org_1',state,operationId:null,revision:1,autoSuspendAfterSeconds:1800,spec:{vcpus:4,memMiB:8192},runtime:{ready:state==='running'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});

test('account and lifecycle API uses real D1, complete pagination, and durable idempotency',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-19',d1Databases:['DB']}));
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    // Another application already owns these generic table and index names.
    for(const sql of [
      'CREATE TABLE accounts (id TEXT PRIMARY KEY, marker TEXT NOT NULL)',
      'CREATE TABLE actions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), marker TEXT NOT NULL)',
      'CREATE UNIQUE INDEX accounts_active_user ON accounts(marker)',
      'CREATE INDEX actions_recent ON actions(marker)',
      'CREATE INDEX actions_account_machine ON actions(account_id)',
      "INSERT INTO accounts VALUES ('other-account','other app credential')",
      "INSERT INTO actions VALUES ('other-action','other-account','other app history')",
    ])await db.prepare(sql).run();
    await migrate(db);
    const calls:{url:string;method:string;key:string;idem:string|null}[]=[];
    const ops=new Map<string,any>();let effects=0,loseReply=false,breakB=false,repeatCursor=false,complete=false;
    const fetcher:Fetcher=async(input,init={})=>{
      const url=new URL(String(input)),headers=new Headers(init.headers),key=headers.get('X-API-Key')||'',method=init.method||'GET',idem=headers.get('Idempotency-Key');
      calls.push({url:url.toString(),method,key,idem});
      assert.equal(url.origin,'https://api.instabox.sh');assert.equal(headers.has('Cookie'),false);assert.equal(headers.has('Cf-Access-Jwt-Assertion'),false);assert.equal(init.redirect,'manual');
      if(url.pathname==='/v1/me')return Response.json({userId:key.includes('account_b')?2:1,login:key.includes('account_b')?'user-b':'user-a',email:'user@example.com'});
      if(url.pathname==='/v1/machines'){
        if(breakB&&key.includes('account_b'))return Response.json({error:{code:'api_key_revoked',message:key}},{status:401});
        if(key.includes('account_b'))return Response.json({machines:[machine('m_b')],nextCursor:null});
        if(repeatCursor)return Response.json({machines:[machine('m_a')],nextCursor:'same'});
        return Response.json(url.searchParams.has('cursor')?{machines:[machine('m_a2','running')],nextCursor:null}:{machines:[machine('m_a')],nextCursor:'page2'});
      }
      if(url.pathname.startsWith('/v1/operations/')){
        const op=[...ops.values()].find(o=>o.id===url.pathname.split('/').pop());
        return Response.json({...op,state:complete?'succeeded':'running',machine:complete?machine(op.machineId,'running'):undefined});
      }
      if(method==='POST'){
        let op=ops.get(idem!);
        if(!op){effects++;op={id:'op_'+effects,machineId:url.pathname.split('/')[3],type:url.pathname.split('/')[4],state:'queued'};ops.set(idem!,op);}
        if(loseReply){loseReply=false;throw new TypeError('Network lost after acceptance');}
        return Response.json(op,{status:202});
      }
      return Response.json(machine(url.pathname.split('/').pop()!));
    };
    const app=createApp({fetcher,authenticate:async()=> ({username:'owner',key:secret})});
    const env={DB:db,KEY_ENCRYPTION_SECRET:secret,ASSETS:{fetch:async()=>new Response('asset')}} as unknown as Env;
    async function call(path:string,method='GET',body?:unknown,headers:Record<string,string>=originHeaders){
      const response=await app.fetch(new Request(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
      return {status:response.status,body:await response.json() as any,headers:response.headers};
    }
    let a:any,b:any;
    await t.test('CSRF blocks writes before an upstream request',async()=>{
      const r=await call('/api/accounts','POST',{label:'A',apiKey:'ibk_account_a'},{...originHeaders,Origin:'https://evil.test'});
      assert.equal(r.status,403);assert.equal(calls.length,0);
    });
    await t.test('account registration checks permissions and never returns stored credentials',async()=>{
      a=(await call('/api/accounts','POST',{label:'主账号',apiKey:'ibk_account_a'})).body.account;
      b=(await call('/api/accounts','POST',{label:'实验室',apiKey:'ibk_account_b'})).body.account;
      assert.ok(a.id);assert.ok(b.id);
      const r=await call('/api/accounts');assert.equal(r.body.accounts.length,2);
      assert.equal(JSON.stringify(r.body).includes('ibk_account_'),false);
      assert.equal(r.headers.get('Cache-Control'),'no-store');
      const stored=await db.prepare('SELECT * FROM insb_accounts WHERE id=?').bind(a.id).first<any>();
      assert.notEqual(stored.key_ciphertext,'ibk_account_a');assert.ok(stored.key_iv);
      assert.equal((await call('/api/accounts','POST',{label:'重复',apiKey:'ibk_account_a_rotated'})).status,409);
    });
    await t.test('all list pages are fetched without any activity request',async()=>{
      const before=calls.length;
      const r=await call('/api/accounts/'+a.id+'/machines');assert.equal(r.status,200);assert.deepEqual(r.body.machines.map((m:any)=>m.id),['m_a','m_a2']);
      assert.equal(calls.length-before,2);assert.ok(calls.slice(before).every(c=>c.method==='GET'&&new URL(c.url).pathname==='/v1/machines'));
      repeatCursor=true;assert.equal((await call('/api/accounts/'+a.id+'/machines')).status,502);repeatCursor=false;
    });
    await t.test('account failure and key rotation cannot cross account boundaries',async()=>{
      breakB=true;const broken=await call('/api/accounts/'+b.id+'/machines');assert.equal(broken.status,422);
      assert.equal(JSON.stringify(broken.body).includes('ibk_'),false);
      assert.equal((await call('/api/accounts/'+a.id+'/machines')).status,200);breakB=false;
      assert.equal((await call('/api/accounts/'+a.id,'PATCH',{apiKey:'ibk_account_b'})).status,409);
    });
    await t.test('accepted operations stay pending, retries are deduplicated, and payload collisions are refused',async()=>{
      const id=crypto.randomUUID(),path='/api/accounts/'+a.id+'/machines/m_a/actions';
      const r=await call(path,'POST',{type:'resume',requestId:id,source:'telegram'});assert.equal(r.status,202);assert.equal(r.body.action.state,'queued');assert.equal(r.body.action.source,'web');
      await call(path,'POST',{type:'resume',requestId:id});assert.equal(effects,1);
      assert.equal((await call(path,'POST',{type:'stop',requestId:id})).status,409);
      assert.equal((await call('/api/actions/'+id+'?wait=0')).body.action.state,'running');
      complete=true;const completed=(await call('/api/actions/'+id)).body.action;assert.equal(completed.state,'succeeded');assert.equal(completed.source,'web');complete=false;
      assert.equal((await call('/api/accounts/'+a.id+'/machines/m_a2/actions','POST',{type:'delete',requestId:crypto.randomUUID()})).status,400);
    });
    await t.test('a lost POST response is recovered using the same persisted upstream idempotency key',async()=>{
      const id=crypto.randomUUID(),path='/api/accounts/'+b.id+'/machines/m_b/actions';loseReply=true;
      const first=await call(path,'POST',{type:'resume',requestId:id});assert.equal(first.body.action.state,'unknown');const effectCount=effects;
      const retry=await call(path,'POST',{type:'resume',requestId:id});assert.equal(retry.body.action.state,'queued');assert.equal(effects,effectCount);
      const posts=calls.filter(c=>c.idem==='panel-'+id);assert.equal(posts.length,2);assert.equal(posts[0].idem,posts[1].idem);
      assert.equal((await call('/api/accounts/'+b.id,'DELETE',{})).status,409);
      complete=true;await call('/api/actions/'+id);complete=false;
    });
    await t.test('account removal erases only credentials and preserves the audit trail',async()=>{
      const before=calls.length;
      assert.equal((await call('/api/accounts/'+b.id,'DELETE',{})).status,200);assert.equal(calls.length,before);
      const stored=await db.prepare('SELECT key_ciphertext,deleted_at FROM insb_accounts WHERE id=?').bind(b.id).first<any>();assert.equal(stored.key_ciphertext,'');assert.ok(stored.deleted_at);
      assert.equal((await call('/api/accounts')).body.accounts.length,1);
      assert.ok((await call('/api/actions')).body.actions.some((x:any)=>x.accountId===b.id));
    });
    await t.test('shared database tables, indexes, and data remain separate from another application',async()=>{
      assert.deepEqual((await db.prepare('SELECT * FROM accounts').all()).results,[{id:'other-account',marker:'other app credential'}]);
      assert.deepEqual((await db.prepare('SELECT * FROM actions').all()).results,[{id:'other-action',account_id:'other-account',marker:'other app history'}]);
      const indexes=await db.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type='index' AND name IN ('accounts_active_user','actions_recent','actions_account_machine','insb_accounts_active_user','insb_actions_recent','insb_actions_account_machine') ORDER BY name").all<{name:string;tbl_name:string}>();
      assert.equal(indexes.results.length,6);
      for(const index of indexes.results)assert.equal(index.tbl_name,index.name.startsWith('insb_')?(index.name.startsWith('insb_accounts_')?'insb_accounts':'insb_actions'):(index.name.startsWith('accounts_')?'accounts':'actions'));
      const foreignKeys=await db.prepare('PRAGMA foreign_key_list(insb_actions)').all<{table:string}>();
      assert.deepEqual(foreignKeys.results.map(key=>key.table),['insb_accounts']);
    });
  }finally{await mf.dispose();}
});

test('real Workers WebSocket proxy preserves PTY binary bytes and resize controls without forwarding browser credentials',async()=>{
  const bundle=await build({stdin:{contents:'import {createApp} from "./src/worker/app.ts"; export default createApp();',resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const upstream=String.raw`export default {async fetch(request) {
    const url=new URL(request.url);
    if(request.headers.get("X-API-Key")!=="ibk_ws_fixture")return Response.json({error:{code:"invalid_api_key"}},{status:401});
    if(request.headers.has("Cookie")||request.headers.has("Origin")||request.headers.has("Cf-Access-Jwt-Assertion"))return new Response("credential leak",{status:500});
    if(url.pathname==="/v1/me")return Response.json({userId:9,login:"ws-fixture"});
    if(url.pathname==="/v1/machines")return Response.json({machines:[],nextCursor:null});
    if(url.pathname.endsWith("/terminal")){
      if(url.searchParams.get("wake")!=="0"||url.searchParams.get("session")!=="panel"||url.searchParams.get("cols")!=="100"||url.searchParams.get("rows")!=="30")return new Response("bad query",{status:400});
      const pair=new WebSocketPair();const client=pair[0],server=pair[1];server.binaryType="arraybuffer";server.accept();
      server.addEventListener("message",event=>server.send(event.data));
      server.send(JSON.stringify({type:"session",session:"panel",persistent:true}));
      return new Response(null,{status:101,webSocket:client});
    }
    return new Response("not found",{status:404});
  }};`;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[
    {name:'panel',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-19',d1Databases:['DB'],outboundService:'upstream'},
    {name:'upstream',modules:true,script:upstream,compatibilityDate:'2026-10-19'},
  ]}));
  try{
    const setup=await mf.dispatchFetch(base+'/api/auth/setup',{method:'POST',headers:originHeaders,body:JSON.stringify({username:'ws-admin',password:'test-websocket-password'})});
    const setupBody=await setup.json();assert.equal(setup.status,201,JSON.stringify(setupBody));
    const cookie=setup.headers.get('Set-Cookie')!.split(';')[0];
    const registered=await mf.dispatchFetch(base+'/api/accounts',{method:'POST',headers:{...originHeaders,Cookie:cookie},body:JSON.stringify({label:'WS',apiKey:'ibk_ws_fixture'})});
    const registration=await registered.json() as any;assert.equal(registered.status,201,JSON.stringify(registration));const {account}=registration;
    const url=base+'/api/accounts/'+account.id+'/machines/m_ws/terminal?cols=100&rows=30';
    assert.equal((await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:base}})).status,401);
    assert.equal((await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:'https://evil.test',Cookie:cookie}})).status,403);
    const response=await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:base,Cookie:cookie+'; private-browser-cookie=secret','Cf-Access-Jwt-Assertion':'private-access-token'}});
    assert.equal(response.status,101);const ws=response.webSocket!;assert.ok(ws);
    function next(){return new Promise<any>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('websocket timeout')),5000);ws.addEventListener('message',e=>{clearTimeout(timeout);resolve(e.data);},{once:true});});}
    let received=next();ws.accept();assert.equal(JSON.parse(await received).type,'session');
    const bytes=new TextEncoder().encode('\x03\x1b[A你好');received=next();ws.send(bytes);assert.deepEqual(new Uint8Array(await received),bytes);
    const resize=JSON.stringify({type:'resize',cols:120,rows:40});received=next();ws.send(resize);assert.equal(await received,resize);
    ws.close(1000,'test complete');
    assert.equal((await mf.dispatchFetch(base+'/api/auth/logout',{method:'POST',headers:{...originHeaders,Cookie:cookie},body:'{}'})).status,200);
    assert.equal((await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:base,Cookie:cookie}})).status,401);
  }finally{await mf.dispose();}
});
