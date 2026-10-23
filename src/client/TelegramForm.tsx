import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Send } from 'lucide-react';
import { Modal } from './App';
import { api, isDemo } from './api';
import type { TelegramStatus } from '../shared/telegram';

export default function TelegramForm({ close }: { close: () => void }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState(''), [chatId, setChatId] = useState(''), [notifyOffline, setNotifyOffline] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api<TelegramStatus>('/api/telegram').then(value => {
      if (!cancelled) { setStatus(value); setChatId(value.chatId); setNotifyOffline(value.notifyOffline); }
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : '无法加载配置。'); });
    return () => { cancelled = true; };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const next = await api<TelegramStatus>('/api/telegram', { method: 'PUT', body: { botToken: token, chatId: chatId.trim(), notifyOffline } });
      setStatus(next); setToken('');
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError('');
    try {
      const result = await api<{ warning: string }>('/api/telegram', { method: 'DELETE', body: {} });
      setStatus(current => current && { ...current, enabled: false, tokenRequired: true, username: '', chatId: '', notifyOffline: false });
      setToken(''); setChatId(''); setNotifyOffline(false); setConfirm(false);
      if (result.warning) setError(result.warning);
    } catch (error) { setError(error instanceof Error ? error.message : '解除绑定失败。'); }
    finally { setBusy(false); }
  }
  return <Modal title="Telegram 机器人" onClose={() => { if (!busy) close(); }}>
    <p className="dialog-description">在私人聊天中点击按钮查看账号、机器和状态，恢复或暂停机器。</p>
    {isDemo && <div className="notice">演示模式只展示设置，不会连接机器人或发送消息。</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {!status ? <p className="field-help">正在加载配置…</p> : <form className="account-form telegram-form" onSubmit={save}>
      {status.enabled && <div className="notice telegram-connected"><Check size={17}/>已绑定 @{status.username} · 私人聊天 {status.chatId}</div>}
      <label>Bot Token<input type="password" autoComplete="new-password" value={token} required={status.tokenRequired} disabled={busy} placeholder={status.enabled ? status.tokenRequired ? '请重新填写原机器人 Token 以恢复绑定' : '留空保留已保存的 Token；更换机器人请先解除绑定' : '从 @BotFather 创建机器人后获取'} onChange={event => setToken(event.target.value)}/></label>
      <label>私人聊天 ID<input inputMode="numeric" pattern="[1-9][0-9]{0,15}" required value={chatId} disabled={busy} onChange={event => setChatId(event.target.value)} placeholder="你的 Telegram 数字用户 ID"/></label>
      <p className="field-help">先在 Telegram 中向自己的机器人发送 /start，再填写你的数字用户 ID。只允许这个用户的私人聊天控制面板，群组和其他用户的命令会被忽略。</p>
      <label className="checkbox-label"><input type="checkbox" checked={notifyOffline} disabled={busy} onChange={event => setNotifyOffline(event.target.checked)}/>机器离线时通知我（默认关闭）</label>
      <p className="field-help">每分钟检测已启用账号。首次检查建立基线；机器由运行变为暂停、停止或异常时通知，同一次离线不重复提醒。接口查询失败不会被当作机器离线。</p>
      {status.enabled && status.tokenRequired && <div className="notice">原机器人凭据无法读取，请重新填写原 Bot Token 后保存设置。无需在 CF 后台配置额外密钥。</div>}
      {status.lastError && <div className="notice error">最近通知检查：{status.lastError}</div>}
      <div className="telegram-commands"><strong>从按钮开始</strong><span>发送 <code>/start</code> 或 <code>/accounts</code>，依次选择账号 → 机器 → 操作，无需输入长 ID。</span><span>暂停前需点击确认；离线通知可直接查看状态。</span><span>从旧版升级后，保存一次机器人设置即可启用按钮；再发送 <code>/accounts</code> 获取新列表。</span><details><summary>手动命令仍可使用</summary><code>/machines 账号ID</code><br/><code>/status 账号ID 机器ID</code><br/><code>/resume 账号ID 机器ID</code><br/><code>/suspend 账号ID 机器ID</code><br/><code>/notifications on</code></details></div>
      <div className="dialog-footer">{status.enabled && <button className="text-button danger-text" type="button" disabled={busy} onClick={() => setConfirm(true)}>解除绑定</button>}<button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <Send size={16}/>}{status.enabled ? '保存机器人设置' : '绑定机器人'}</button></div>
      {confirm && <div className="delete-confirm"><p>解除后将停止 Telegram 控制与通知，保活设置不受影响。</p><button type="button" className="button danger" disabled={busy} onClick={() => void disconnect()}>确认解除绑定</button><button type="button" className="button subtle" onClick={() => setConfirm(false)}>取消</button></div>}
    </form>}
  </Modal>;
}
