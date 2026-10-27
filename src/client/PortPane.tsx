import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, Network, Pencil, Plus, RefreshCw, Unplug } from 'lucide-react';
import { Modal, type MachineRow } from './App';
import { api, ApiError } from './api';
import { maxPublicPorts, portInputError, publicPortUrl, type PublicPort, type PublicPortOverview } from '../shared/ports';

const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试。';
interface Draft { port: string; name: string; editing: boolean }

export default function PortPane({ row, onClose, onAuthError }: { row: MachineRow; onClose: () => void; onAuthError: (error: unknown) => void }) {
  const [accountId, setAccountId] = useState(row.account.id);
  const account = row.sources.find(a => a.id === accountId);
  const base = '/api/accounts/' + accountId + '/machines/' + row.machine.id + '/ports';
  const [data, setData] = useState<PublicPortOverview | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null), [removing, setRemoving] = useState<PublicPort | null>(null);
  const mounted = useRef(true), mutationLock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    void api<PublicPortOverview>(base, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
      .then(value => { if (!stopped) { setData(value); setLoadError(''); } })
      .catch(error => { if (!stopped) { setLoadError(errorText(error)); onAuthError(error); } })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [base, revision, busy, onAuthError]);

  const canChange = !!data && !loading && !busy && !loadError && !!account?.enabled;
  const canPublish = canChange && data.enabled;
  function selectAccount(id: string) {
    setAccountId(id); setData(null); setLoading(true); setDraft(null); setRemoving(null); setError(''); setNotice(''); setLoadError('');
  }
  async function run(task: () => Promise<unknown>, success: string) {
    if (mutationLock.current) return;
    mutationLock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await task();
      if (mounted.current) { setDraft(null); setRemoving(null); setNotice(success); }
    } catch (error) {
      if (mounted.current) {
        const uncertain = !(error instanceof ApiError) || !error.status || error.status >= 500;
        setError(errorText(error) + (uncertain ? ' 提交结果尚未确认，请核对刷新后的端口列表再操作。' : ''));
        onAuthError(error);
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) { setBusy(false); setRevision(value => value + 1); }
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !canPublish) return;
    const port = Number(draft.port), name = draft.name.trim() || 'Port ' + port;
    const error = portInputError(port, name);
    if (error) { setError(error); return; }
    if (!draft.editing && data?.ports.some(p => p.port === port)) { setError('这个端口已经公开，请使用列表中的改名按钮。'); return; }
    void run(() => api(base, { method: 'POST', body: { port, name } }), draft.editing ? '端口名称已保存，访问地址保持不变。' : '端口已公开。');
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); if (mounted.current) { setNotice('访问地址已复制。'); setError(''); } }
    catch { if (mounted.current) setError('无法自动复制，请选中下方地址手动复制。'); }
  }

  return <Modal title={row.machine.name + ' · 端口转发'} onClose={() => { if (!mutationLock.current) onClose(); }} wide><div className="port-pane">
    <div className="port-toolbar"><p className="dialog-description">为机器上的 HTTP 服务提供公网 HTTPS 地址，支持发布端口、改名和取消转发。</p><div>
      <button className="button compact" disabled={busy || loading} onClick={() => setRevision(v => v + 1)}><RefreshCw size={14} className={loading ? 'spin' : ''}/>刷新端口</button>
      <button className="button primary compact" disabled={!canPublish || data.ports.length >= maxPublicPorts} onClick={() => { setDraft({ port: '', name: '', editing: false }); setRemoving(null); setError(''); setNotice(''); }}><Plus size={14}/>发布端口</button>
    </div></div>
    {row.sources.length > 1 ? <label className="port-account">操作账号<select aria-label="端口操作账号" value={accountId} disabled={busy} onChange={e => selectAccount(e.target.value)}>{row.sources.map(a => <option value={a.id} key={a.id} disabled={!a.enabled}>{a.label}</option>)}</select></label> : <p className="field-help">操作账号：{account?.label || row.account.label}</p>}
    <p className="field-help">查看需 machines:read，修改需 machines:write。每台最多 16 个端口，范围为 1024–65535；5901、6768 及平台配置的控制端口保留。</p>
    <div className="notice">公网地址可被任何持有链接的人访问，请在服务中设置登录保护。发布端口不会启动服务，也不提供通用 TCP/UDP 转发。</div>
    {row.machine.state !== 'running' && <div className="notice">机器当前未运行。转发配置仍保留，访问地址会在机器运行且端口上的服务启动后恢复。</div>}
    {!account?.enabled && <div className="notice">操作账号已停用或移除，请重新启用账号或切换操作账号。</div>}
    {data && !data.enabled && <div className="notice">平台尚未启用公网端口服务，暂时不能发布端口。</div>}
    {data && data.ports.length >= maxPublicPorts && <p className="field-help">已达到 16 个公开端口的上限；可改名或取消已有转发。</p>}
    {loadError && <div className="notice error" role="alert">{loadError} 当前列表可能已过期，请刷新后再修改。</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice success" role="status"><Check size={16}/>{notice}</div>}
    {draft && <form className="port-form" onSubmit={save}>
      <h3>{draft.editing ? '修改端口名称' : '发布端口'}</h3>
      <div className="port-fields"><label>端口号<input autoFocus={!draft.editing} type="number" min={1024} max={65535} step={1} required value={draft.port} disabled={busy || draft.editing} onChange={e => setDraft({ ...draft, port: e.target.value })} placeholder="例如 3000"/></label>
        <label>端口名称（可选）<input autoFocus={draft.editing} value={draft.name} maxLength={100} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如 开发预览"/></label></div>
      <p className="field-help">{draft.editing ? '改名保留当前访问地址。更换端口请发布新端口，再取消旧端口转发。' : '填写机器上已经运行的 HTTP 服务端口，留空名称时使用 Port 加端口号。'}</p>
      <div className="port-form-actions"><button className="button primary" disabled={!canPublish}>{busy ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>} {draft.editing ? '保存名称' : '确认发布'}</button><button type="button" className="button subtle" disabled={busy} onClick={() => setDraft(null)}>取消</button></div>
    </form>}
    {removing && <div className="port-remove">
      <h3>取消 {removing.port} 端口转发？</h3><p>“{removing.name || 'Port ' + removing.port}”的公网地址将失效，现有连接会断开。机器中的服务仍继续运行。</p>
      <div className="port-form-actions"><button className="button danger" disabled={!canChange} onClick={() => void run(() => api(base + '/' + removing.port, { method: 'DELETE', body: { confirmPort: removing.port, portId: removing.id } }), '端口转发已取消。')}>确认取消转发</button><button className="button subtle" disabled={busy} onClick={() => setRemoving(null)}>保留转发</button></div>
    </div>}
    {loading && <div className="port-loading" role="status"><LoaderCircle size={16} className="spin"/>正在读取端口…</div>}
    {data && <div className="port-count">已公开 {data.ports.length} / {maxPublicPorts} 个端口</div>}
    {data && !data.ports.length ? <div className="port-empty"><Network size={28}/><p>暂无公开端口</p></div> : <div className="port-list">{data?.ports.map(port => {
      const url = data.enabled ? publicPortUrl(port.url) : '';
      return <article className="port-card" key={port.id}>
        <div className="port-card-heading"><span className="port-number">{port.port}</span><strong>{port.name || 'Port ' + port.port}</strong><div>
          <button className="icon-button" aria-label={'修改端口 ' + port.port + ' 名称'} title="修改名称" disabled={!canPublish} onClick={() => { setDraft({ port: String(port.port), name: port.name, editing: true }); setRemoving(null); setError(''); }}><Pencil size={16}/></button>
          <button className="icon-button danger-text" aria-label={'取消端口 ' + port.port + ' 转发'} title="取消转发" disabled={!canChange} onClick={() => { setRemoving(port); setDraft(null); setError(''); }}><Unplug size={16}/></button>
        </div></div>
        {url ? <div className="port-address"><a href={url} target="_blank" rel="noopener noreferrer">{url}<ExternalLink size={13}/></a><button className="icon-button" aria-label={'复制端口 ' + port.port + ' 地址'} title="复制地址" onClick={() => void copy(url)}><Copy size={15}/></button></div> : <p className="field-help">访问地址暂不可用</p>}
        <small>发布时间：{new Date(port.createdAt).toLocaleString('zh-CN')}</small>
      </article>;
    })}</div>}
  </div></Modal>;
}
