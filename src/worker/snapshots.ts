import type { MachineSnapshot, SnapshotPayload, SnapshotRequest } from '../shared/resources';
import type { ResourceAccess, ResourceApp, ResourceContext } from './resource-context';
import { resourceBody, resourceId } from './resource-context';
import { PanelError } from './errors';
import { ensureDatabase } from './schema';
import type { Instabox } from './instabox';

export function snapshotView(raw: any): MachineSnapshot {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.sourceMachineId !== 'string' || !['pending','ready','failed'].includes(raw.status))
    throw new PanelError(502,'invalid_snapshot','平台快照数据不完整，请重试。');
  return {id:raw.id,name:raw.name,description:typeof raw.description==='string'?raw.description:'',orgId:String(raw.orgId||''),sourceMachineId:raw.sourceMachineId,status:raw.status,
    createdAt:typeof raw.createdAt==='string'?raw.createdAt:'',rootSizeBytes:Number(raw.rootSizeBytes)||0,dataSizeBytes:typeof raw.dataSizeBytes==='number'?raw.dataSizeBytes:null,
    error:raw.status==='failed'?'平台未能保存此快照，请到官方控制台核查后重试。':''};
}
export function snapshotPayload(body: Record<string,unknown>): SnapshotPayload {
  if(typeof body.name!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.name)) throw new PanelError(400,'invalid_snapshot_name','快照名称需为 1–63 个小写字母、数字或连字符，并以字母或数字开头。');
  if(body.description!==undefined&&(typeof body.description!=='string'||body.description.length>2000)) throw new PanelError(400,'invalid_snapshot_description','快照说明不能超过 2000 个字符。');
  if(body.rootOnly!==undefined&&typeof body.rootOnly!=='boolean') throw new PanelError(400,'invalid_snapshot_scope','快照范围无效。');
  return {name:body.name,description:String(body.description||''),rootOnly:body.rootOnly===true};
}
interface RequestRow {id:string;account_id:string;machine_id:string;type:'create'|'delete';snapshot_id:string|null;name:string;payload:string;state:SnapshotRequest['state'];error:string;created_at:string;updated_at:string}
const stamp=()=>new Date().toISOString();
const view=(row:RequestRow):SnapshotRequest=>({id:row.id,machineId:row.machine_id,type:row.type,snapshotId:row.snapshot_id,name:row.name,payload:JSON.parse(row.payload),
  state:row.state==='submitting'&&Date.now()-Date.parse(row.updated_at)>30000?'unknown':row.state,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at});
async function stored(db:D1Database,id:string) {return db.prepare('SELECT * FROM insb_snapshot_requests WHERE id=?').bind(id).first<RequestRow>();}
async function snapshotList(remote:Instabox) {
  const result=await remote.request('/v1/snapshots');
  if(!result||!Array.isArray(result.snapshots))throw new PanelError(502,'invalid_snapshot_list','平台快照列表不完整。');
  return result.snapshots.map(snapshotView) as MachineSnapshot[];
}
export function registerSnapshotRoutes(app:ResourceApp,access:ResourceAccess) {
  async function context(c:ResourceContext) {
    await ensureDatabase(c.env.DB);
    const row=await access.account(c.env.DB,resourceId(c.req.param('id')));
    return {row,db:c.env.DB,remote:await access.remote(c.get('identity'),row)};
  }
  async function execute(db:D1Database,remote:Instabox,record:RequestRow) {
    try {
      if(record.type==='create') {
        const result=snapshotView(await remote.request('/v1/machines/'+encodeURIComponent(record.machine_id)+'/snapshots',{
          method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'panel-snapshot-'+record.id},body:record.payload,
        },30000));
        await db.prepare("UPDATE insb_snapshot_requests SET snapshot_id=?,state=?,error=?,updated_at=? WHERE id=? AND state='submitting' AND updated_at=?")
          .bind(result.id,result.status==='pending'?'pending':result.status==='ready'?'succeeded':'failed',result.error,stamp(),record.id,record.updated_at).run();
      } else {
        await remote.request('/v1/snapshots/'+encodeURIComponent(record.snapshot_id!),{method:'DELETE',headers:{'Idempotency-Key':'panel-snapshot-'+record.id,'X-Confirm-Delete':record.snapshot_id!}});
        await db.prepare("UPDATE insb_snapshot_requests SET state='succeeded',error='',updated_at=? WHERE id=? AND state='submitting' AND updated_at=?").bind(stamp(),record.id,record.updated_at).run();
      }
    } catch(error) {
      const e=error instanceof PanelError?error:new PanelError(502,'snapshot_uncertain','快照请求结果待确认，请重试原请求。',true);
      const gone=record.type==='delete'&&e.status===404;
      await db.prepare("UPDATE insb_snapshot_requests SET state=?,error=?,updated_at=? WHERE id=? AND state='submitting' AND updated_at=?")
        .bind(gone?'succeeded':e.status>=500?'unknown':'failed',gone?'':e.code==='insufficient_scope'?'快照权限不足：查看需 images:read，创建需 images:write，删除需 images:delete。':e.message,stamp(),record.id,record.updated_at).run();
    }
    return view((await stored(db,record.id))!);
  }
  async function retry(db:D1Database,remote:Instabox,record:RequestRow) {
    if(!['unknown','submitting'].includes(record.state))return view(record);
    if(Date.now()-Date.parse(record.created_at)>6*86400000)throw new PanelError(409,'retry_window_expired','原快照请求已超过安全重试期限，请到官方控制台确认结果。');
    const claimed=await db.prepare("UPDATE insb_snapshot_requests SET state='submitting',updated_at=?,error='' WHERE id=? AND (state='unknown' OR (state='submitting' AND updated_at<?))")
      .bind(stamp(),record.id,new Date(Date.now()-30000).toISOString()).run();
    const current=(await stored(db,record.id))!;
    return claimed.meta.changes?execute(db,remote,current):view(current);
  }
  app.get('/api/accounts/:id/snapshots',async c=>{
    const {row,db,remote}=await context(c);
    let snapshots:MachineSnapshot[];
    try {snapshots=await snapshotList(remote);}catch(error){if(error instanceof PanelError&&error.code==='insufficient_scope')throw new PanelError(422,'snapshot_scope','查看快照需要 images:read 权限，请在账号设置中替换 Key。');throw error;}
    const requests=await db.prepare("SELECT * FROM insb_snapshot_requests WHERE account_id=? AND (state IN ('submitting','unknown','pending') OR id IN (SELECT id FROM insb_snapshot_requests WHERE account_id=? ORDER BY created_at DESC LIMIT 30)) ORDER BY created_at DESC").bind(row.id,row.id).all<RequestRow>();
    for(const request of requests.results)if(request.state==='pending') {
      const snapshot=snapshots.find(item=>item.id===request.snapshot_id);
      if(snapshot&&snapshot.status!=='pending') {request.state=snapshot.status==='ready'?'succeeded':'failed';request.error=snapshot.error;request.updated_at=stamp();
        await db.prepare('UPDATE insb_snapshot_requests SET state=?,error=?,updated_at=? WHERE id=? AND state=?').bind(request.state,request.error,request.updated_at,request.id,'pending').run();}
      else if(!snapshot) { // A collaborator can remove a pending snapshot; settle it so the account is not locked forever.
        try {const current=snapshotView(await remote.request('/v1/snapshots/'+encodeURIComponent(request.snapshot_id!)));if(current.status!=='pending'){request.state=current.status==='ready'?'succeeded':'failed';request.error=current.error;}}
        catch(error){if(error instanceof PanelError&&error.status===404){request.state='failed';request.error='快照已被移除。';}else throw error;}
        if(request.state!=='pending')await db.prepare('UPDATE insb_snapshot_requests SET state=?,error=?,updated_at=? WHERE id=?').bind(request.state,request.error,stamp(),request.id).run();
      }
    }
    return c.json({snapshots,requests:requests.results.map(view)});
  });
  async function submit(c:ResourceContext,type:'create'|'delete') {
    const {row,db,remote}=await context(c),body=await resourceBody(c);
    if(typeof body.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))throw new PanelError(400,'invalid_request_id','请求标识无效。');
    const target=resourceId(type==='create'?c.req.param('machineId'):c.req.param('snapshotId'));
    const payload=type==='create'?snapshotPayload(body):{confirmName:typeof body.confirmName==='string'?body.confirmName:''};
    const old=await stored(db,body.requestId);
    if(old) {
      if(old.account_id!==row.id||old.type!==type||(type==='create'?old.machine_id:old.snapshot_id)!==target||old.payload!==JSON.stringify(payload))throw new PanelError(409,'idempotency_conflict','这个请求标识已用于其他快照操作。');
      return c.json({request:await retry(db,remote,old)},202);
    }
    let machineId=target,name:string,snapshotId:string|null=null;
    if(type==='create') {
      const machine=await remote.machine(target);
      if(!['running','stopped'].includes(machine.state)||machine.operationId)throw new PanelError(409,'snapshot_machine_state','请在机器运行中或完全停止且没有进行中操作时创建快照；暂停中的机器需先恢复。');
      name=(payload as SnapshotPayload).name;
    } else {
      const snapshot=snapshotView(await remote.request('/v1/snapshots/'+encodeURIComponent(target)));
      if((payload as {confirmName:string}).confirmName!==snapshot.name)throw new PanelError(409,'delete_confirmation_required','请输入要删除的快照的完整名称。');
      machineId=snapshot.sourceMachineId;name=snapshot.name;snapshotId=target;
    }
    const timestamp=stamp();
    const inserted=await db.prepare("INSERT OR IGNORE INTO insb_snapshot_requests (id,account_id,machine_id,type,snapshot_id,name,payload,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'submitting',?,? WHERE EXISTS(SELECT id FROM insb_accounts WHERE id=? AND enabled=1 AND deleted_at IS NULL)")
      .bind(body.requestId,row.id,machineId,type,snapshotId,name,JSON.stringify(payload),timestamp,timestamp,row.id).run();
    const record=await stored(db,body.requestId);
    if(!record)throw new PanelError(409,'account_disabled','账号已停用或移除，请刷新。');
    if(record.account_id!==row.id||record.type!==type||record.payload!==JSON.stringify(payload)||record.machine_id!==machineId||(type==='delete'&&record.snapshot_id!==snapshotId))throw new PanelError(409,'idempotency_conflict','请求标识冲突。');
    return c.json({request:inserted.meta.changes?await execute(db,remote,record):view(record)},202);
  }
  app.post('/api/accounts/:id/machines/:machineId/snapshots',c=>submit(c,'create'));
  app.delete('/api/accounts/:id/snapshots/:snapshotId',c=>submit(c,'delete'));
  app.post('/api/accounts/:id/snapshot-requests/:requestId/retry',async c=>{
    const {row,db,remote}=await context(c),record=await stored(db,resourceId(c.req.param('requestId')));
    if(!record||record.account_id!==row.id)throw new PanelError(404,'snapshot_request_not_found','未找到此账号的快照请求。');
    return c.json({request:await retry(db,remote,record)},202);
  });
}
