import { useState, useEffect, useRef, type FC } from 'react';
import type { TickerPin, TickerSlotData, TickerBroadcastPayload } from '../types';
import type { GroupOps } from '../hooks/useTickerPins';
import TickerSetup from './TickerSetup';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TickerBarMainProps {
  mode:           'main';
  displayPins:    TickerPin[];  // active group's sorted pins (rendered in single-row)
  allPins:        TickerPin[];  // all pins across all groups (passed to TickerSetup)
  slots:          Record<string, TickerSlotData>;
  payload:        TickerBroadcastPayload;
  groupOps:       GroupOps;
  dualRow:        boolean;
  onRemovePin:    (id: string) => void;
  onReorder:      (pins: TickerPin[]) => void;
  onToggleDualRow:() => void;
}

interface TickerBarPopoutProps {
  mode: 'popout';
}

type TickerBarProps = TickerBarMainProps | TickerBarPopoutProps;

// ── Direction arrow ───────────────────────────────────────────────────────────

const Arrow: FC<{ dir: TickerSlotData['direction']; color: TickerSlotData['colorClass'] }> = ({ dir, color }) => {
  if (!dir || dir === 'stable') return null;
  return (
    <span className={`ticker-arrow ticker-color-${color}`} aria-hidden="true">
      {dir === 'up' ? '▲' : '▼'}
    </span>
  );
};

// ── Single slot ───────────────────────────────────────────────────────────────

const Slot: FC<{ pin: TickerPin; slot: TickerSlotData }> = ({ pin, slot }) => {
  const animClass = slot.animClass !== 'none' ? ` ticker-anim-${slot.animClass}` : '';
  const persistClass = slot.colorClass !== 'neutral' ? ` ticker-persist-${slot.colorClass}` : '';
  return (
    <div className="ticker-seg" title={`${pin.label}${slot.secondaryText ? ' · ' + slot.secondaryText : ''} — open ⚙ to manage this pin`}>
      <span className="ticker-label">{pin.label}</span>
      <span
        key={slot.flashKey}
        className={`ticker-value ticker-color-${slot.colorClass}${animClass}${persistClass}`}
      >
        {slot.loading ? <span className="ticker-loading">…</span> : slot.primaryText}
        <Arrow dir={slot.direction} color={slot.colorClass} />
      </span>
      {slot.secondaryText && (
        <span className="ticker-sub">{slot.secondaryText}</span>
      )}
    </div>
  );
};

// ── Pins list (shared between main and popout) ───────────────────────────────

interface PinsListProps {
  pins:  TickerPin[];
  slots: Record<string, TickerSlotData>;
}

const PinsList: FC<PinsListProps> = ({ pins, slots }) => (
  <>
    {pins.map(pin => {
      const slot = slots[pin.id];
      if (!slot) return null;
      return <Slot key={pin.id} pin={pin} slot={slot} />;
    })}
  </>
);

// ── Scrolling pins container (auto-marquee when overflow) ─────────────────────

interface ScrollingPinsProps {
  pins:            TickerPin[];
  slots:           Record<string, TickerSlotData>;
  empty:           React.ReactNode;
  speedMultiplier?: number; // 1.0 default; >1 faster, <1 slower
}

const ScrollingPins: FC<ScrollingPinsProps> = ({ pins, slots, empty, speedMultiplier = 1 }) => {
  const wrapRef    = useRef<HTMLDivElement>(null);
  const innerRef   = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState(false);
  const [speed,   setSpeed]   = useState(40); // px/s

  useEffect(() => {
    const wrap  = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;

    const check = () => {
      const overflow = inner.scrollWidth > wrap.clientWidth + 10;
      setMarquee(overflow);
      if (overflow) {
        // ~20px/s for short lists, faster for long ones (capped at 80)
        const ratio = inner.scrollWidth / wrap.clientWidth;
        setSpeed(Math.min(80, Math.max(25, ratio * 18)));
      }
    };

    check();
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [pins, slots]);

  if (pins.length === 0) return (
    <div className="ticker-pins-wrap" ref={wrapRef}>
      <div className="ticker-pins-inner" ref={innerRef}>{empty}</div>
    </div>
  );

  const duration = marquee && innerRef.current
    ? `${(innerRef.current.scrollWidth / (speed * speedMultiplier)).toFixed(1)}s`
    : undefined;

  return (
    <div className="ticker-pins-wrap" ref={wrapRef}>
      <div
        className={`ticker-pins-inner${marquee ? ' ticker-marquee' : ''}`}
        style={marquee ? { '--ticker-dur': duration } as React.CSSProperties : undefined}
        ref={innerRef}
      >
        <PinsList pins={pins} slots={slots} />
        {/* Duplicate for seamless loop */}
        {marquee && <PinsList pins={pins} slots={slots} />}
      </div>
    </div>
  );
};

// ── Live indicator dot ─────────────────────────────────────────────────────────

const LiveDot: FC = () => (
  <span className="ticker-live-dot" title="Live — prices and values refresh automatically every 30 seconds" aria-label="Live data" />
);

// ── Group switcher (shown when 2+ layouts exist) ──────────────────────────────

const GroupSwitcher: FC<{ groupOps: GroupOps }> = ({ groupOps }) => {
  const { groups, activeGroupId, setActiveGroup } = groupOps;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (groups.length <= 1) return null;

  const active = groups.find(g => g.id === activeGroupId) ?? groups[0];

  return (
    <div className="ticker-group-switcher" ref={ref}>
      <button
        type="button"
        className="ticker-group-btn"
        onClick={() => setOpen(o => !o)}
        title="Switch ticker layout — each layout has its own set of pinned data"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="ticker-group-dot" style={{ background: active.color }} />
        <span className="ticker-group-name">{active.name}</span>
        <span className="ticker-group-caret">▾</span>
      </button>
      {open && (
        <div className="ticker-group-menu" role="menu">
          {groups.map(g => (
            <button
              key={g.id}
              type="button"
              role="menuitem"
              className={`ticker-group-menu-item${g.id === activeGroupId ? ' active' : ''}`}
              style={g.id === activeGroupId ? { borderLeftColor: g.color } : undefined}
              onClick={() => { setActiveGroup(g.id); setOpen(false); }}
            >
              <span style={{ color: g.color }}>●</span> {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Main bar (in main FORGE window) ──────────────────────────────────────────

const TickerBarMain: FC<TickerBarMainProps> = ({
  displayPins, allPins, slots, payload, groupOps, dualRow, onRemovePin, onReorder, onToggleDualRow,
}) => {
  const [setupOpen, setSetupOpen] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!channelRef.current) channelRef.current = new BroadcastChannel('forge-ticker');
    const ch = channelRef.current;
    ch.postMessage({ type: 'data', payload });
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'request') ch.postMessage({ type: 'data', payload });
    };
    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }, [payload]);

  useEffect(() => {
    return () => { channelRef.current?.close(); channelRef.current = null; };
  }, []);

  const handlePopOut = () => {
    window.open(
      `${window.location.origin}/?ticker=1`,
      'forge-ticker',
      'width=1600,height=68,toolbar=no,menubar=no,scrollbars=no,resizable=yes,location=no,status=no'
    );
  };

  const empty = (
    <span className="ticker-empty">
      Hover any item and click <span className="ticker-empty-pin">⊕</span> to pin data here
    </span>
  );

  // Dual-row: show first two groups as separate scrolling rows
  const { groups } = groupOps;
  const isDual = dualRow && groups.length >= 2;
  const pinsForGroup = (gid: string) =>
    allPins.filter(p => p.groupId === gid).sort((a, b) => a.order - b.order);

  return (
    <>
      <div className={`ticker-bar${isDual ? ' ticker-bar--dual' : ''}`} role="status" aria-label="FORGE ticker">
        <LiveDot />
        <GroupSwitcher groupOps={groupOps} />

        {isDual ? (
          <div className="ticker-dual-rows">
            {groups.slice(0, 2).map((g, rowIdx) => {
              const rowPins = pinsForGroup(g.id);
              return (
                <div key={g.id} className={`ticker-row ticker-row--${rowIdx === 0 ? 'fast' : 'slow'}`}>
                  <span className="ticker-row-dot" style={{ background: g.color }} title={g.name} />
                  <ScrollingPins
                    pins={rowPins}
                    slots={slots}
                    empty={<span className="ticker-empty-small">No pins in {g.name}</span>}
                    speedMultiplier={rowIdx === 0 ? 1.6 : 0.65}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <ScrollingPins pins={displayPins} slots={slots} empty={empty} />
        )}

        <div className="ticker-controls">
          {groups.length >= 2 && (
            <button
              type="button"
              className={`ticker-ctrl-btn${dualRow ? ' ticker-ctrl-btn--active' : ''}`}
              onClick={onToggleDualRow}
              title={dualRow ? 'Single-row mode — click to show one layout at a time' : 'Dual-row mode — shows two layouts simultaneously, scrolling at different speeds'}
              aria-label="Toggle dual-row mode"
            >⊟</button>
          )}
          <button type="button" className="ticker-ctrl-btn" onClick={() => setSetupOpen(true)} title="Ticker setup — manage pins, reorder, create layouts, enable dual-row mode" aria-label="Open ticker setup">⚙</button>
          <button type="button" className="ticker-ctrl-btn" onClick={handlePopOut} title="Pop out — opens the ticker in its own window, perfect for a second monitor" aria-label="Pop out ticker">↗</button>
        </div>
      </div>

      <TickerSetup
        open={setupOpen}
        pins={allPins}
        slots={slots}
        groupOps={groupOps}
        dualRow={dualRow}
        onRemove={onRemovePin}
        onReorder={onReorder}
        onToggleDualRow={onToggleDualRow}
        onClose={() => setSetupOpen(false)}
      />
    </>
  );
};

// ── Pop-out mode (standalone /?ticker=1 window) ───────────────────────────────

const TickerBarPopout: FC = () => {
  const [pins,  setPins]  = useState<TickerPin[]>([]);
  const [slots, setSlots] = useState<Record<string, TickerSlotData>>({});
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    document.title = 'FORGE Ticker';
    document.documentElement.setAttribute('data-theme', localStorage.getItem('forge-theme') ?? 'dark');
    document.documentElement.style.height = '100%';
    document.body.style.cssText = 'margin:0;padding:0;height:100%;overflow:hidden;';
  }, []);

  useEffect(() => {
    const ch = new BroadcastChannel('forge-ticker');
    ch.onmessage = (e: MessageEvent) => {
      const p = e.data?.payload as TickerBroadcastPayload | undefined;
      if (p) { setPins(p.pins); setSlots(p.slots); }
    };
    ch.postMessage({ type: 'request' });
    return () => ch.close();
  }, []);

  const empty = <span className="ticker-empty">Waiting for FORGE connection…</span>;

  return (
    <>
      <div className="ticker-bar ticker-bar--popout" role="status" aria-label="FORGE ticker">
        <LiveDot />

        <ScrollingPins pins={pins} slots={slots} empty={empty} />

        <div className="ticker-controls">
          <button
            type="button"
            className="ticker-ctrl-btn"
            onClick={() => setSetupOpen(true)}
            title="View pins"
            aria-label="View ticker pins"
          >⚙</button>
          <button
            type="button"
            className="ticker-ctrl-btn"
            onClick={() => window.close()}
            title="Close ticker"
            aria-label="Close"
          >✕</button>
        </div>
      </div>

      <TickerSetup
        open={setupOpen}
        pins={pins}
        slots={slots}
        groupOps={{ groups: [{ id: 'default', name: 'Default', color: '#00ff88' }], activeGroupId: 'default', setActiveGroup: () => {}, addGroup: () => {}, removeGroup: () => {}, renameGroup: () => {}, movePin: () => {} }}
        dualRow={false}
        onRemove={() => {}}
        onReorder={() => {}}
        onToggleDualRow={() => {}}
        onClose={() => setSetupOpen(false)}
      />
    </>
  );
};

// ── Exports ───────────────────────────────────────────────────────────────────

const TickerBar: FC<TickerBarProps> = (props) => {
  if (props.mode === 'popout') return <TickerBarPopout />;
  return <TickerBarMain {...props} />;
};

export default TickerBar;
