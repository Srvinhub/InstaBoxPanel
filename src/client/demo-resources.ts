import type { Account, Machine } from '../shared/types';
import type { DesktopState, MachineSnapshot, SnapshotOverview, SnapshotRequest } from '../shared/resources';
import { ApiError } from './api';
const desktops=new Map<string,DesktopState>(),libraries=new Map<string,SnapshotOverview>();
const stamp=()=>new Date().toISOString();
export function demoResources(path:string,method:string,body:Record<string,any>|undefined,accounts:Account[],machines:Record<string,Machine[]>):unknown {
  const match=path.match(/^\/api\/accounts\/([^/]+)\/(.+)$/);if(!match)return undefined;
  const [,accountId,resource]=match;
  if(!/^(?:machines\/[^/]+\/(?:desktop|snapshots)|snapshots|snapshot-requests)/.test(resource))return undefined;
  if(!accounts.some(a=>a.id===accountId&&a.enabled))throw new ApiError('account_disabled','账号不存在或已停用。',409);
  const desktop=resource.match(/^machines\/([^/]+)\/desktop$/);
  if(desktop) {
    const machine=machines[accountId]?.find(m=>m.id===desktop[1]);if(!machine)throw new ApiError('not_found','机器不存在。',404);
    let state=desktops.get(machine.id);
    if(!state){state={installed:!machine.id.includes('preview'),installing:false,failed:false,running:machine.id.includes('development'),agentPausable:true,controller:'agent',yours:false,controlError:'',actions:[{time:stamp(),tool:'get_app_state',refused:false}]};desktops.set(machine.id,state);}
    if(machine.state!=='running')throw new ApiError('machine_not_running','请先恢复或启动机器。',409);
    if(method==='POST') {
      if(body?.action==='install'){state.installing=true;const current=state;setTimeout(()=>{current.installed=true;current.installing=false;},700);}
      else if(body?.action==='start'){state.installed=true;state.running=true;}
      else if(body?.action==='takeover'){state.controller='human';state.yours=true;state.actions.push({time:stamp(),tool:'click',refused:true});}
      else if(body?.action==='handback'){state.controller='agent';state.yours=false;}
    }
    return structuredClone(state);
  }
  let data=libraries.get(accountId);
  if(!data){data={snapshots:[{id:'sn_demo_'+accountId,name:'initial-backup',description:'演示快照',orgId:'org_demo',sourceMachineId:machines[accountId]?.[0]?.id||'m_removed',status:'ready',createdAt:stamp(),rootSizeBytes:1024**3*2,dataSizeBytes:1024**3,error:''}],requests:[]};libraries.set(accountId,data);}
  if(resource==='snapshots'&&method==='GET')return structuredClone(data);
  const create=resource.match(/^machines\/([^/]+)\/snapshots$/),remove=resource.match(/^snapshots\/([^/]+)$/),retry=resource.match(/^snapshot-requests\/([^/]+)\/retry$/);
  if(retry){const request=data.requests.find(r=>r.id===retry[1]);if(!request)throw new ApiError('not_found','请求不存在。',404);return {request:structuredClone(request)};}
  if((create&&method==='POST')||(remove&&method==='DELETE')) {
    const old=data.requests.find(r=>r.id===body?.requestId);if(old)return {request:structuredClone(old)};
    let snapshot:MachineSnapshot,request:SnapshotRequest;
    if(create) {
      const machine=machines[accountId]?.find(m=>m.id===create[1]);
      if(!machine||!['running','stopped'].includes(machine.state))throw new ApiError('snapshot_machine_state','请先恢复机器，或等待机器完全停止。',409);
      if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body?.name||''))throw new ApiError('invalid_snapshot_name','快照名称无效。',400);
      if(data.snapshots.some(s=>s.name===body?.name))throw new ApiError('name_taken','快照名称已被使用。',409);
      snapshot={id:'sn_'+crypto.randomUUID(),name:body!.name,description:body?.description||'',orgId:machine.orgId,sourceMachineId:machine.id,status:machine.state==='running'?'pending':'ready',createdAt:stamp(),rootSizeBytes:2*1024**3,dataSizeBytes:body?.rootOnly?null:1024**3,error:''};
      data.snapshots.push(snapshot);
      request={id:body!.requestId,type:'create',machineId:machine.id,snapshotId:snapshot.id,name:snapshot.name,payload:{name:snapshot.name,description:snapshot.description,rootOnly:body?.rootOnly===true},state:snapshot.status==='pending'?'pending':'succeeded',error:'',createdAt:stamp(),updatedAt:stamp()};
      if(snapshot.status==='pending')setTimeout(()=>{snapshot.status='ready';request.state='succeeded';request.updatedAt=stamp();},900);
    }else{
      const found=data.snapshots.find(s=>s.id===remove![1]);if(!found)throw new ApiError('not_found','快照不存在。',404);snapshot=found;
      if(body?.confirmName!==snapshot.name)throw new ApiError('delete_confirmation_required','请输入完整的快照名称。',409);
      data.snapshots=data.snapshots.filter(s=>s.id!==snapshot.id);
      request={id:body!.requestId,type:'delete',machineId:snapshot.sourceMachineId,snapshotId:snapshot.id,name:snapshot.name,payload:{confirmName:snapshot.name},state:'succeeded',error:'',createdAt:stamp(),updatedAt:stamp()};
    }
    data.requests.unshift(request);return {request:structuredClone(request)};
  }
  return undefined;
}
