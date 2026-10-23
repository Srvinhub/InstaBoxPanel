import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface Bounds { left: number; top: number; width: number; height: number }
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
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
  const gesture = useRef<{ pointerId: number; clientX: number; clientY: number; bounds: Bounds; kind: 'move' | ResizeCorner } | null>(null);
  useEffect(() => {
    const resize = () => setBounds(current => constrain(current));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function start(event: PointerEvent<HTMLElement>, kind: 'move' | ResizeCorner) {
    if (maximized || event.button !== 0 || (kind === 'move' && (event.target as HTMLElement).closest('button'))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, bounds, kind };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - current.clientX, deltaY = event.clientY - current.clientY;
    const initial = current.bounds;
    if (current.kind === 'move') {
      setBounds(constrain({ ...initial, left: initial.left + deltaX, top: initial.top + deltaY }));
      return;
    }
    const minWidth = Math.min(360, window.innerWidth - 12), minHeight = Math.min(280, window.innerHeight - 12);
    const right = initial.left + initial.width, bottom = initial.top + initial.height;
    const west = current.kind.endsWith('w'), north = current.kind.startsWith('n');
    const left = west ? clamp(initial.left + deltaX, 6, right - minWidth) : initial.left;
    const top = north ? clamp(initial.top + deltaY, 6, bottom - minHeight) : initial.top;
    setBounds({ left, top,
      width: west ? right - left : clamp(initial.width + deltaX, minWidth, window.innerWidth - left - 6),
      height: north ? bottom - top : clamp(initial.height + deltaY, minHeight, window.innerHeight - top - 6),
    });
  }
  function end(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId === event.pointerId) {
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  return { maximized, toggleMaximized: () => setMaximized(current => !current),
    style: maximized ? { left: 0, top: 0, width: '100vw', height: '100dvh' } : bounds,
    drag: { onPointerDown: (event: PointerEvent<HTMLElement>) => start(event, 'move'), onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end },
    resize: (corner: ResizeCorner) => ({ onPointerDown: (event: PointerEvent<HTMLElement>) => start(event, corner), onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end }),
  };
}
