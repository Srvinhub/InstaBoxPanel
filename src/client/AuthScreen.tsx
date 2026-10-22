import { useState, type FormEvent } from 'react';
import { Box, Check, LoaderCircle, LockKeyhole, LogIn, ShieldCheck } from 'lucide-react';
import { api, ApiError, isDemo } from './api';
import type { Session } from '../shared/types';

export default function AuthScreen({ status, onAuthenticated, refresh }: { status: Session; onAuthenticated: (session: Session) => void; refresh: () => Promise<void> }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const setup = status.setupRequired;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (setup && password !== confirmation) { setError('两次输入的密码不一致。'); return; }
    setBusy(true);
    try {
      const session = await api<Session>(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { username, password } });
      setPassword(''); setConfirmation(''); onAuthenticated(session);
    } catch (error) {
      setError(error instanceof Error ? error.message : '暂时无法登录，请重试。');
      if (error instanceof ApiError && ['already_initialized', 'setup_required'].includes(error.code)) await refresh();
    } finally { setBusy(false); }
  }
  return <main className="auth-screen">
    <div className="auth-brand"><span className="brand-mark"><Box size={24}/></span><span>instabox<small>PANEL</small></span></div>
    <section className="auth-card" aria-labelledby="auth-title">
      <span className="auth-emblem">{setup ? <ShieldCheck size={25}/> : <LockKeyhole size={25}/>}</span>
      <div className="eyebrow">YOUR PRIVATE WORKSPACE</div><h1 id="auth-title">{setup ? '设置管理员账号' : '登录私人控制台'}</h1>
      <p className="auth-description">{setup ? '首次使用，创建自己的账号和密码，开始管理所有机器。' : '使用管理员账号登录，继续你的工作。'}</p>
      {isDemo && <div className="notice"><span>演示模式：登录信息和机器数据只在本页面内存中保存，请使用示例密码。</span></div>}
      <form className="account-form auth-form" onSubmit={submit}>
        <label>管理员账号<input autoFocus required minLength={3} maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} disabled={busy} onChange={event=>setUsername(event.target.value)} placeholder="例如：admin"/></label>
        <label>密码<input type="password" required minLength={setup ? 12 : 1} maxLength={128} autoComplete={setup ? 'new-password' : 'current-password'} value={password} disabled={busy} onChange={event=>setPassword(event.target.value)} placeholder={setup ? '至少 12 个字符' : '输入管理员密码'}/></label>
        {setup && <><label>确认密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmation} disabled={busy} onChange={event=>setConfirmation(event.target.value)} placeholder="再次输入密码"/></label><p className="field-help">首次设置后将关闭设置入口。请将密码保存在密码管理器中。</p></>}
        {error && <div className="notice error" role="alert">{error}</div>}
        <button className="button primary auth-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin"/> : setup ? <Check size={17}/> : <LogIn size={17}/>} {busy ? '正在验证…' : setup ? '创建管理员并进入' : '登录'}</button>
      </form>
    </section>
    <p className="auth-caption"><ShieldCheck size={14}/>一个控制台，统一管理多个 InstaBox 账号</p>
  </main>;
}
