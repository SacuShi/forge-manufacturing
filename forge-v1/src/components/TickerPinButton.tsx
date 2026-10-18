import { useState, useRef, useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useTickerContext } from '../hooks/useTickerPins';
import type { TickerPinType, NewPinConfig } from '../types';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface PinOption {
  type: TickerPinType;
  label: string;
}

interface TickerPinButtonProps {
  options: PinOption[];
  baseConfig: Omit<NewPinConfig, 'type' | 'label'>;
}

interface PopoverPos { top?: number; bottom?: number; right: number; }

const TickerPinButton: FC<TickerPinButtonProps> = ({ options, baseConfig }) => {
  const { addPin, removePin, isPinned, pins } = useTickerContext();
  const [open, setOpen]       = useState(false);
  const [pos,  setPos]        = useState<PopoverPos | null>(null);
  const btnRef                = useRef<HTMLButtonElement>(null);
  const popoverRef            = useRef<HTMLDivElement>(null);
  const openedByKeyboard      = useRef(false);

  // Calculate portal position from the trigger button's screen coords
  const openPopover = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    openedByKeyboard.current = e.detail === 0; // Enter/Space on the button fires a click with detail 0
    const rect = btnRef.current!.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    // Prefer above; fall back to below if not enough room
    if (spaceAbove >= 120 || spaceAbove >= spaceBelow) {
      setPos({ bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right });
    } else {
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen(true);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        !btnRef.current?.contains(e.target as Node) &&
        !popoverRef.current?.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Keyboard: Escape closes and returns focus to the button; a keyboard-opened menu focuses its first item.
  useEscapeKey(() => { setOpen(false); btnRef.current?.focus(); }, open);
  useEffect(() => {
    if (open && pos && openedByKeyboard.current) {
      popoverRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [open, pos]);

  const moveFocus = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  // Close on window scroll (position would drift if the button's ancestor scrolls).
  // Not capture-phase so inner scrollable containers (item table, sidebar) don't
  // trigger a close when the user is scrolling past the button to look at items.
  useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, [open]);

  const withState = options.map(opt => ({
    ...opt,
    pinned: isPinned(opt.type, baseConfig.typeId, baseConfig.regionId),
    pinId:  pins.find(p =>
      p.type === opt.type &&
      (baseConfig.typeId === undefined || p.typeId === baseConfig.typeId) &&
      (baseConfig.regionId === undefined || p.regionId === baseConfig.regionId)
    )?.id,
  }));

  const allPinned = withState.every(o => o.pinned);

  const handleSelect = (e: React.MouseEvent, opt: typeof withState[number]) => {
    e.stopPropagation();
    if (opt.pinned && opt.pinId) {
      removePin(opt.pinId);
    } else {
      addPin({ ...baseConfig, type: opt.type, label: opt.label });
    }
    setOpen(false);
  };

  if (options.length === 0) return null;

  // Single-option: toggle directly, no popover
  if (options.length === 1) {
    const opt = withState[0];
    const tip = opt.pinned
      ? `📌 Pinned to ticker — click to remove`
      : `⊕ Pin "${opt.label}" to the live ticker bar`;
    return (
      <button
        type="button"
        className={`ticker-pin-btn${opt.pinned ? ' ticker-pin-btn--active' : ''}`}
        onClick={e => handleSelect(e, opt)}
        title={tip}
        aria-label={tip}
      >
        {opt.pinned ? '📌' : '⊕'}
      </button>
    );
  }

  // Multi-option: portal popover (renders at document body — escapes all stacking contexts)
  const tip = allPinned
    ? '📌 All options pinned — click to manage'
    : '⊕ Pin this data to the live ticker bar';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`ticker-pin-btn${allPinned ? ' ticker-pin-btn--active' : ''}`}
        onClick={openPopover}
        title={tip}
        aria-label={tip}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {allPinned ? '📌' : '⊕'}
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          className="ticker-pin-popover"
          role="menu"
          tabIndex={-1}
          style={{ position: 'fixed', ...pos }}
          onClick={e => e.stopPropagation()}
          onKeyDown={moveFocus}
        >
          <div className="ticker-pin-popover-title">Pin to Ticker</div>
          {withState.map(opt => (
            <button
              key={opt.type}
              type="button"
              className={`ticker-pin-option${opt.pinned ? ' ticker-pin-option--active' : ''}`}
              role="menuitem"
              title={opt.pinned ? 'Click to remove from ticker' : 'Click to add to ticker bar'}
              onClick={e => handleSelect(e, opt)}
            >
              <span className="ticker-pin-option-icon">{opt.pinned ? '📌' : '○'}</span>
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
};

export default TickerPinButton;
