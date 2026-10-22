import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface Bounds { left: number; top: number; width: number; height: number }
function constrain(bounds: Bounds): Bounds {
  const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
  const width = Math.max(Math.min(360, viewportWidth - 12), Math.min(bounds.width, viewportWidth - 12));
  const height = Math.max(Math.min(280, viewportHeight - 12), Math.min(bounds.height, viewportHeight - 12));
  return { width, height, left: Math.max(6, Math.min(bounds.left, viewportWidth - width - 6)),
    top: Math.max(6, Math.min(bounds.top, viewportHeight - height - 6)) };
}
export function useFloatingWindow(index: number) {
  const [bounds, setBounds] = useState<Bounds>(() => constrain({
    left: Math.max(12, (window.innerWidth - 900) / 2) + index * 28, top: 105 + index * 28,
    width: 900, height: Math.min(620, window.innerHeight - 150),
  }));
  const [maximized, setMaximized] = useState(false);
  const gesture = useRef<{ pointerId: number; clientX: number; clientY: number; bounds: Bounds; kind: 'move' | 'resize' } | null>(null);
  useEffect(() => {
    const resize = () => setBounds(current => constrain(current));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function start(event: PointerEvent<HTMLElement>, kind: 'move' | 'resize') {
    if (maximized || event.button !== 0 || (kind === 'move' && (event.target as HTMLElement).closest('button'))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, bounds, kind };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - current.clientX, deltaY = event.clientY - current.clientY;
    setBounds(constrain(current.kind === 'move'
      ? { ...current.bounds, left: current.bounds.left + deltaX, top: current.bounds.top + deltaY }
      : { ...current.bounds, width: current.bounds.width + deltaX, height: current.bounds.height + deltaY }));
  }
  function end(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  }
  return { maximized, toggleMaximized: () => setMaximized(current => !current),
    style: maximized ? { left: 0, top: 0, width: '100vw', height: '100dvh' } : bounds,
    drag: { onPointerDown: (event: PointerEvent<HTMLElement>) => start(event, 'move'), onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end },
    resize: { onPointerDown: (event: PointerEvent<HTMLElement>) => start(event, 'resize'), onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end },
  };
}
