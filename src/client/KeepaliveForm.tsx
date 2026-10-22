import { useState, type FormEvent } from 'react';
import { Check, HeartPulse, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { Modal, type MachineRow } from './App';
import { api } from './api';
import { validateSchedule, type KeepaliveMode, type KeepaliveOverview, type TimeWindow } from '../shared/keepalive';

export default function KeepaliveForm({ row, overview, close, saved }: {
  row: MachineRow; overview: KeepaliveOverview; close: () => void; saved: (value: KeepaliveOverview) => void;
}) {
  const current = overview.policies.find(policy => policy.machineId === row.machine.id);
  const [mode, setMode] = useState<KeepaliveMode>(current?.mode || 'off');
  const [timezone, setTimezone] = useState(current?.timezone || 'Asia/Shanghai');
  const [windows, setWindows] = useState<TimeWindow[]>(current?.windows.length ? current.windows : [{ start: '09:00', end: '18:00' }]);
  const [accountId, setAccountId] = useState(row.sources.some(account => account.id === current?.accountId && account.enabled) ? current!.accountId : row.account.id);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const policy = validateSchedule({ mode, timezone, windows });
      setBusy(true);
      saved(await api<KeepaliveOverview>('/api/accounts/' + accountId + '/machines/' + row.machine.id + '/keepalive', { method: 'PUT', body: policy }));
      close();
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <Modal title={'保活 · ' + row.machine.name} onClose={() => { if (!busy) close(); }}>
    <p className="dialog-description">每 {overview.intervalMinutes} 分钟检查，暂停时自动恢复。关闭网页后仍然生效。</p>
    <form className="account-form keepalive-form" onSubmit={save}>
      <fieldset disabled={busy}><legend className="sr-only">保活模式</legend>
        {([['off', '不保活', '默认，保持机器原有的自动暂停行为'], ['always', '全天保活', '全天检测并恢复已暂停的机器'], ['windows', '指定时间范围', '每天仅在指定时间窗口内检测和恢复']] as const).map(([value, label, description]) =>
          <label className={'keepalive-option' + (mode === value ? ' selected' : '')} key={value}><input type="radio" name="keepalive-mode" value={value} checked={mode === value} onChange={() => setMode(value)}/><span><strong>{label}</strong><small>{description}</small></span></label>)}
      </fieldset>
      {mode !== 'off' && <>
        {row.sources.length > 1 && <label>执行账号<select value={accountId} onChange={event => setAccountId(event.target.value)}>{row.sources.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>}
        {mode === 'windows' && <>
          <label>时间范围时区<input value={timezone} onChange={event => setTimezone(event.target.value)} required placeholder="Asia/Shanghai" list="keepalive-timezones"/></label>
          <datalist id="keepalive-timezones">{['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London'].map(zone => <option key={zone} value={zone}/>)}</datalist>
          <div className="keepalive-windows">{windows.map((window, index) => <div className="keepalive-window" key={index}>
            <label>开始<input aria-label={'时间范围 ' + (index + 1) + ' 开始'} type="time" required value={window.start} onChange={event => setWindows(current => current.map((item, position) => position === index ? { ...item, start: event.target.value } : item))}/></label><span>至</span>
            <label>结束<input aria-label={'时间范围 ' + (index + 1) + ' 结束'} type="time" required value={window.end} onChange={event => setWindows(current => current.map((item, position) => position === index ? { ...item, end: event.target.value } : item))}/></label>
            <button type="button" className="icon-button" aria-label={'删除时间范围 ' + (index + 1)} disabled={windows.length === 1} onClick={() => setWindows(current => current.filter((_, position) => position !== index))}><Trash2 size={16}/></button>
          </div>)}</div>
          <button className="button" type="button" disabled={windows.length >= 5} onClick={() => setWindows(current => [...current, { start: '19:00', end: '22:00' }])}><Plus size={15}/>添加时间范围（{windows.length}/5）</button>
          <p className="field-help">支持跨午夜，例如 22:00–06:00；开始时间包含在内，结束时间不包含。窗口外不会主动暂停机器。</p>
        </>}
        <div className="notice"><HeartPulse size={17}/><span>自动暂停后通常在下一分钟检查时发起恢复，实际恢复还需启动时间。已停止的机器需手动启动；保活开启时，手动暂停也会被下一次检查恢复。最多同时保活 {overview.maxMachines} 台。</span></div>
      </>}
      {!overview.configured && <div className="notice">启用保活前，请在 CF 后台添加密钥 AUTOMATION_SECRET。可在本地执行 npm run secret:generate 生成，设置方法见 README。关闭保活不需要该密钥。</div>}
      {current?.lastCheckedAt && <p className="field-help">最近检查：{new Date(current.lastCheckedAt).toLocaleString('zh-CN')} · {current.lastResult}{current.lastError && ' · ' + current.lastError}</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="button primary" disabled={busy || (mode !== 'off' && !overview.configured)}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}保存保活设置</button>
    </form>
  </Modal>;
}
