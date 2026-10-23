import { useEffect, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { TerminalWindow } from './useTerminalWindows';

export default function TerminalDock({ windows, restore, close }: {
  windows: TerminalWindow[]; restore: (id: string) => void; close: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const counting = windows.some(item => item.closeAt !== null);
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  if (!windows.length) return null;
  return <aside className="terminal-dock" aria-label="收起的终端">
    {windows.map(({ row, closeAt }) => <div key={row.machine.id} className={'terminal-dock-item' + (closeAt !== null ? ' closing' : '')}>
      <button className="terminal-dock-restore" aria-label={'恢复 ' + row.machine.name + ' 终端'}
        title={row.machine.name + ' · ' + row.account.label + (closeAt === null ? ' · 已最小化，点击恢复' : ' · 60 秒内恢复可取消断开')}
        onClick={() => restore(row.machine.id)}>
        <span className="terminal-dock-square"><Maximize2 size={17}/></span>
        <span className="terminal-dock-label"><strong>{row.machine.name}</strong><small>{closeAt === null ? '已最小化' : Math.max(0, Math.min(60, Math.ceil((closeAt - now) / 1000))) + ' 秒后断开'}</small></span>
      </button>
      <button className="terminal-dock-close" aria-label={'立即断开 ' + row.machine.name + ' 终端'} title="立即断开连接并移除窗口" onClick={() => close(row.machine.id)}><X size={14}/></button>
    </div>)}
  </aside>;
}
