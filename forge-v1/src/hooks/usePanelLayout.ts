import { useState, useRef, useCallback, useEffect } from 'react';

export function usePanelLayout() {
  // v1.16.0 — user-resizable panels (left + right). Persisted across sessions.
  // The right panel stays collapsed (width 0) until an item is selected (detailOpen).
  const PANEL_WIDTHS_KEY = 'forge_panel_widths';

  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try { return JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) || '{}').left ?? 240; } catch { return 240; }
  });

  const [rightWidth, setRightWidth] = useState<number>(() => {
    try { return JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) || '{}').right ?? 460; } catch { return 460; }
  });

  const appBodyRef = useRef<HTMLDivElement>(null);

  const panelDragRef = useRef<null | { which: 'left' | 'right'; startX: number; startW: number }>(null);

  // ── Panel resize (v1.16.0) ────────────────────────────────────────────────
  // Delta-from-drag-start (robust — independent of element offsets/overflow) +
  // pointer capture so the drag survives the cursor leaving the thin handle.
  const startPanelDrag = useCallback((which: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    panelDragRef.current = {
      which,
      startX: e.clientX,
      startW: which === 'left' ? leftWidth : rightWidth,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = panelDragRef.current;
      if (!d) return;
      const delta = e.clientX - d.startX;
      if (d.which === 'left') {
        // Drag right → wider.
        setLeftWidth(Math.min(Math.max(d.startW + delta, 180), 460));
      } else {
        // Right panel is right-docked: drag left → wider, drag right → narrower.
        setRightWidth(Math.min(Math.max(d.startW - delta, 300), 760));
      }
    };
    const onUp = () => {
      if (!panelDragRef.current) return;
      panelDragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // Persist panel widths
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify({ left: leftWidth, right: rightWidth }));
    } catch { /* ignore */ }
  }, [leftWidth, rightWidth]);

  return { appBodyRef, leftWidth, rightWidth, startPanelDrag };
}
