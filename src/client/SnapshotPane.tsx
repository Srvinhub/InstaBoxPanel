import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, Plus, RefreshCw, Trash2, LoaderCircle, Check, CircleAlert } from 'lucide-react';
import { Modal, type MachineRow } from './App';
import { api, ApiError } from './api';
import type { Account } from '../shared/types';
import type { MachineSnapshot, SnapshotOverview, SnapshotRequest } from '../shared/resources';
const labels={pending:'保存中',ready:'可用',failed:'失败'};
const requestLabels={submitting:'提交中',pending:'保存中',succeeded:'已完成',failed:'失败',unknown:'结果待确认'};
const size=(bytes:number|null)=>bytes===null?'未包含':bytes>=1024**3?(bytes/1024**3).toFixed(2)+' GiB':(bytes/1024**2).toFixed(1)+' MiB';
const errorText=(e:unknown)=>e instanceof Error?e.message:'请求失败，请重试。';
export default function SnapshotPane({account,row,onClose}:{account:Account;row?:MachineRow;onClose:()=>void}) {
  const base='/api/accounts/'+account.id;
  const [data,setData]=useState<SnapshotOverview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [loadError,setLoadError]=useState('');
  const [all,setAll]=useState(!row),[creating,setCreating]=useState(false),[deleting,setDeleting]=useState<MachineSnapshot|null>(null),[confirm,setConfirm]=useState('');
  const [name,setName]=useState((row?.machine.name||'snapshot').toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,35)+'-'+new Date().toISOString().replace(/[-:]/g,'').slice(0,15).toLowerCase());
  const [description,setDescription]=useState(''),[rootOnly,setRootOnly]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
  const draft=useRef<string|null>(null),deleteId=useRef<string|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let stopped=false,timer:number;const controller=new AbortController();
    const poll=async()=>{
      try{const value=await api<SnapshotOverview>(base+'/snapshots',{signal:controller.signal});if(!stopped){setData(value);setLoadError('');}}
      catch(e){if(!stopped)setLoadError(errorText(e));}
      finally{if(!stopped){setLoading(false);timer=window.setTimeout(poll,document.hidden?30000:5000);}}
    };void poll();return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[base,revision]);
  const pending=data?.requests.some(r=>r.type==='create'&&r.machineId===row?.machine.id&&['submitting','pending','unknown'].includes(r.state));
  const canCreate=!!row&&account.enabled&&!row.stale&&!row.machine.operationId&&['running','stopped'].includes(row.machine.state);
  async function run(task:()=>Promise<{request:SnapshotRequest}>) {
    setBusy(true);setError('');
    try{const result=await task();if(!mounted.current)return;
      setRevision(value=>value+1);
      if(result.request.state==='failed'){
        setError(result.request.error||'快照请求失败。');setUncertain(false);draft.current=null;deleteId.current=null;return;
      }
      setCreating(false);setDeleting(null);setUncertain(false);draft.current=null;deleteId.current=null;
    }catch(e){if(mounted.current){
      const definite=e instanceof ApiError&&e.status>=400&&e.status<500;
      setError(errorText(e));setUncertain(!definite);if(definite){draft.current=null;deleteId.current=null;}setRevision(value=>value+1);
    }}
    finally{if(mounted.current)setBusy(false);}
  }
  function create(e:FormEvent) {e.preventDefault();draft.current||=crypto.randomUUID();void run(()=>api(base+'/machines/'+row!.machine.id+'/snapshots',{method:'POST',body:{requestId:draft.current,name,description,rootOnly}}));}
  const snapshots=(data?.snapshots||[]).filter(s=>all||s.sourceMachineId===row?.machine.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const requests=(data?.requests||[]).filter(r=>all||r.machineId===row?.machine.id);
  return <Modal title={(row?row.machine.name:account.label)+' · 快照'} onClose={()=>{if(!busy)onClose();}} wide>
    <div className="snapshot-top"><p className="dialog-description">{account.label} · 查看保存版本、创建新快照或删除旧快照。</p><div><button className="button compact" disabled={busy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={14}/>刷新快照</button>{row&&<button className="button primary compact" disabled={busy||!canCreate||pending} onClick={()=>{draft.current=null;setUncertain(false);setCreating(true);setDeleting(null);}}><Plus size={14}/>新增快照</button>}</div></div>
    <p className="field-help">快照权限：查看需 images:read，新增需 images:write，删除需 images:delete。权限不足时请在账号设置中替换 Key。</p>
    {row&&<label className="checkbox-label snapshot-filter"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>显示此账号全部快照（含其他或已移除机器）</label>}
    {row&&!canCreate&&<div className="notice">新增快照需要机器运行中或完全停止，且没有其他机器操作；暂停中的机器请先恢复。</div>}
    {error&&<div className="notice error" role="alert">{error}</div>}
    {loadError&&<div className="notice error" role="alert">{loadError}</div>}
    {creating&&<form className="snapshot-form" onSubmit={create}><h3>新增快照</h3><label>快照名称<input autoFocus required pattern={'[a-z0-9][a-z0-9\\x2d]{0,62}'} maxLength={63} value={name} disabled={busy||uncertain} onChange={e=>{setName(e.target.value);draft.current=null;}}/></label><label>快照说明<textarea maxLength={2000} value={description} disabled={busy||uncertain} onChange={e=>{setDescription(e.target.value);draft.current=null;}}/></label><label className="checkbox-label"><input type="checkbox" checked={rootOnly} disabled={busy||uncertain} onChange={e=>{setRootOnly(e.target.checked);draft.current=null;}}/>仅保存系统文件，不包含 /data</label><p className="field-help">完整快照包含 /data 和主目录中的凭据；不保存内存及运行中的进程。运行中创建时文件会短暂冻结，保存完成后才可使用。</p><div className="snapshot-form-actions"><button className="button primary" disabled={busy||(!uncertain&&pending)}>{busy?<LoaderCircle size={14} className="spin"/>:<Check size={14}/>} {uncertain?'重试本次提交':'创建快照'}</button><button type="button" className="button subtle" disabled={busy} onClick={()=>{setCreating(false);setUncertain(false);}}>关闭表单</button></div></form>}
    {deleting&&<div className="snapshot-delete"><h3>删除快照“{deleting.name}”？</h3><p>删除后无法再用它创建机器。已经从该快照创建的机器不受影响。</p><label>确认快照名称<input autoFocus value={confirm} disabled={busy} placeholder={deleting.name} onChange={e=>setConfirm(e.target.value)}/></label><div className="snapshot-form-actions"><button className="button danger" disabled={busy||confirm!==deleting.name} onClick={()=>{deleteId.current||=crypto.randomUUID();void run(()=>api(base+'/snapshots/'+deleting.id,{method:'DELETE',body:{requestId:deleteId.current,confirmName:confirm}}));}}>确认删除快照</button><button className="button subtle" disabled={busy} onClick={()=>{setDeleting(null);setUncertain(false);}}>取消</button></div></div>}
    {loading?<div className="empty"><LoaderCircle className="spin"/>正在读取快照…</div>:!snapshots.length?<div className="snapshot-empty"><Archive size={28}/><p>暂无快照</p></div>:<div className="snapshot-list">{snapshots.map(snapshot=><article key={snapshot.id} className="snapshot-card"><div className="snapshot-card-heading"><strong>{snapshot.name}</strong><span className={'snapshot-state '+snapshot.status}>{labels[snapshot.status]}</span><button className="icon-button" aria-label={'删除快照 '+snapshot.name} disabled={busy||data?.requests.some(r=>r.snapshotId===snapshot.id&&r.type==='delete'&&['unknown','submitting'].includes(r.state))} onClick={()=>{setDeleting(snapshot);setCreating(false);setConfirm('');deleteId.current=null;setUncertain(false);}}><Trash2 size={16}/></button></div>{snapshot.description&&<p>{snapshot.description}</p>}<dl><div><dt>创建时间</dt><dd>{new Date(snapshot.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>保存范围</dt><dd>{snapshot.dataSizeBytes===null?'仅系统文件':'系统文件 + /data'}</dd></div><div><dt>系统 / 数据</dt><dd>{size(snapshot.rootSizeBytes)} / {size(snapshot.dataSizeBytes)}</dd></div><div><dt>源机器</dt><dd>{snapshot.sourceMachineId}</dd></div><div><dt>快照 ID</dt><dd>{snapshot.id}</dd></div></dl>{snapshot.error&&<p className="history-error">{snapshot.error}</p>}</article>)}</div>}
    {!!requests.length&&<section className="snapshot-requests"><h3>最近快照请求</h3>{requests.map(request=><div key={request.id}><span>{['unknown','failed'].includes(request.state)?<CircleAlert size={14}/>:request.state==='succeeded'?<Check size={14}/>:<LoaderCircle size={14} className="spin"/>}</span><div><strong>{request.type==='create'?'新增':'删除'} · {request.name}</strong><small>{requestLabels[request.state]}{request.error?' · '+request.error:''}</small></div>{request.state==='unknown'&&<button className="button compact" disabled={busy} onClick={()=>void run(()=>api(base+'/snapshot-requests/'+request.id+'/retry',{method:'POST',body:{}}))}>重试原请求</button>}</div>)}</section>}
  </Modal>;
}
