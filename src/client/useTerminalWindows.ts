import { useEffect, useState } from 'react';
import type { MachineRow } from './App';

export interface TerminalWindow { row: MachineRow; minimized: boolean; closeAt: number | null }
interface Workspace { windows: TerminalWindow[]; activeId: string }
const selectActive = (windows: TerminalWindow[], preferred: string) =>
  windows.find(item => !item.minimized && item.row.machine.id === preferred)?.row.machine.id ||
  [...windows].reverse().find(item => !item.minimized)?.row.machine.id || '';

export function useTerminalWindows() {
  const [workspace, setWorkspace] = useState<Workspace>({ windows: [], activeId: '' });
  useEffect(() => {
    const expire = () => setWorkspace(current => {
      const windows = current.windows.filter(item => item.closeAt === null || item.closeAt > Date.now());
      return windows.length === current.windows.length ? current : { windows, activeId: selectActive(windows, current.activeId) };
    });
    const deadlines = workspace.windows.flatMap(item => item.closeAt === null ? [] : [item.closeAt]);
    const timer = deadlines.length ? window.setTimeout(expire, Math.max(0, Math.min(...deadlines) - Date.now())) : undefined;
    // Recheck wall-clock deadlines when returning from a throttled background tab.
    window.addEventListener('focus', expire);
    document.addEventListener('visibilitychange', expire);
    return () => { clearTimeout(timer); window.removeEventListener('focus', expire); document.removeEventListener('visibilitychange', expire); };
  }, [workspace.windows]);

  const restore = (id: string) => setWorkspace(current => ({
    windows: current.windows.map(item => item.row.machine.id === id ? { ...item, minimized: false, closeAt: null } : item), activeId: id,
  }));
  const open = (row: MachineRow) => setWorkspace(current => {
    const existing = current.windows.some(item => item.row.machine.id === row.machine.id);
    if (!existing && current.windows.length >= 8) return current;
    const windows = existing
      ? current.windows.map(item => item.row.machine.id === row.machine.id ? { ...item, minimized: false, closeAt: null } : item)
      : [...current.windows, { row, minimized: false, closeAt: null }];
    return { windows, activeId: row.machine.id };
  });
  const hide = (id: string, delayedClose: boolean) => setWorkspace(current => {
    const windows = current.windows.map(item => item.row.machine.id === id
      ? { ...item, minimized: true, closeAt: delayedClose ? Date.now() + 60_000 : null } : item);
    return { windows, activeId: selectActive(windows, current.activeId) };
  });
  const close = (id: string) => setWorkspace(current => {
    const windows = current.windows.filter(item => item.row.machine.id !== id);
    return { windows, activeId: selectActive(windows, current.activeId) };
  });
  const activate = (id: string) => setWorkspace(current => current.activeId === id ? current : { ...current, activeId: id });
  return { ...workspace, open, restore, hide, close, activate };
}
