import { useState, useRef, type FC } from 'react';
import type { TickerPin, TickerSlotData } from '../types';
import type { GroupOps } from '../hooks/useTickerPins';

interface TickerSetupProps {
  open:           boolean;
  pins:           TickerPin[];   // ALL pins (all groups)
  slots:          Record<string, TickerSlotData>;
  groupOps:       GroupOps;
  dualRow:        boolean;
  onRemove:       (id: string) => void;
  onReorder:      (pins: TickerPin[]) => void;
  onToggleDualRow:() => void;
  onClose:        () => void;
}

const PIN_TYPE_LABELS: Record<string, string> = {
  price_sell:      'Sell price',
  price_buy:       'Buy price',
  price_spread:    'Spread %',
  mfg_profit:      'Mfg profit/run (Gross)',
  mfg_margin:      'Mfg margin % (Gross)',
  mfg_isk_hour:    'Mfg ISK/hr (Gross)',
  mfg_top_hub:     'Top mfg opp (Gross)',
  trade_spread:    'Spread profit %',
  trade_top_hub:   'Top trade opp',
  wallet:          'Wallet ISK',
  jobs_count:      'Active jobs',
  jobs_next:       'Next job',
  jobs_free_slots: 'Free slots',
  pi_extractor:    'PI ECU expiry',
  pi_colony_isk:   'PI ISK/day',
};

const TickerSetup: FC<TickerSetupProps> = ({
  open, pins, slots, groupOps, dualRow, onRemove, onReorder, onToggleDualRow, onClose,
}) => {
  const { groups, activeGroupId, setActiveGroup, addGroup, removeGroup, renameGroup, movePin } = groupOps;

  const [renamingId,    setRenamingId]    = useState<string | null>(null);
  const [renameValue,   setRenameValue]   = useState('');
  const [dragIndex,     setDragIndex]     = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragCounterRef = useRef(0); // tracks nested dragenter/dragleave

  if (!open) return null;

  const displayPins = pins
    .filter(p => p.groupId === activeGroupId)
    .sort((a, b) => a.order - b.order);

  // ── Drag-to-reorder handlers ──────────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, i: number) => {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  };

  const handleDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (i !== dragOverIndex) setDragOverIndex(i);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== dropIndex) {
      const next = [...displayPins];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(dropIndex, 0, moved);
      onReorder(next);
    }
    setDragIndex(null);
    setDragOverIndex(null);
    dragCounterRef.current = 0;
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragCounterRef.current = 0;
  };

  // ── Group tab helpers ─────────────────────────────────────────────────────
  const handleTabClick = (id: string) => {
    if (renamingId) return;
    setActiveGroup(id);
  };

  const startRename = (e: React.MouseEvent, g: typeof groups[number]) => {
    e.stopPropagation();
    setRenamingId(g.id);
    setRenameValue(g.name);
  };

  const commitRename = () => {
    if (renamingId) renameGroup(renamingId, renameValue);
    setRenamingId(null);
  };

  return (
    <div className="ticker-setup-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Ticker configuration">
      <div className="ticker-setup" onClick={e => e.stopPropagation()}>

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="ticker-setup-header">
          <span className="ticker-setup-title">Ticker Setup</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {groups.length >= 2 && (
              <button
                type="button"
                className={`ticker-setup-dual-toggle${dualRow ? ' active' : ''}`}
                onClick={onToggleDualRow}
                title={dualRow ? 'Switch to single-row ticker' : 'Switch to dual-row ticker (shows 2 layouts at once)'}
              >
                {dualRow ? '⊟ Single row' : '⊞ Dual row'}
              </button>
            )}
            <button type="button" className="ticker-setup-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {/* ── Group tabs ────────────────────────────────────────────────────── */}
        <div className="ticker-setup-group-tabs">
          {groups.map(g => (
            <div
              key={g.id}
              className={`ticker-setup-group-tab${g.id === activeGroupId ? ' active' : ''}`}
              onClick={() => handleTabClick(g.id)}
              style={g.id === activeGroupId ? { borderBottomColor: g.color } : undefined}
            >
              <span className="ticker-setup-group-dot" style={{ background: g.color }} />
              {renamingId === g.id ? (
                <input
                  autoFocus
                  className="ticker-setup-group-tab-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  commitRename();
                    if (e.key === 'Escape') setRenamingId(null);
                    e.stopPropagation();
                  }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span
                  className="ticker-setup-group-tab-name"
                  onDoubleClick={e => startRename(e, g)}
                  title="Double-click to rename"
                >
                  {g.name}
                </span>
              )}
              {groups.length > 1 && (
                <button
                  type="button"
                  className="ticker-setup-group-tab-del"
                  onClick={e => { e.stopPropagation(); removeGroup(g.id); }}
                  title={`Delete the "${g.name}" layout — any pins in it will move to your first remaining layout`}
                  aria-label={`Delete ${g.name} layout`}
                >×</button>
              )}
            </div>
          ))}
          {groups.length < 6 && (
            <button
              type="button"
              className="ticker-setup-group-add"
              onClick={addGroup}
              title="Add a new empty layout — useful for separating manufacturing pins from trading pins, for example"
            >+ Layout</button>
          )}
        </div>

        {/* ── Pin list (active group, drag-to-reorder) ─────────────────────── */}
        {displayPins.length === 0 ? (
          <div className="ticker-setup-empty">
            No pins in this layout. Use <strong>⊕</strong> on any data in FORGE to add items here.
          </div>
        ) : (
          <div className="ticker-setup-list">
            {displayPins.map((pin, i) => {
              const slot = slots[pin.id];
              const isDragging  = dragIndex     === i;
              const isDragOver  = dragOverIndex === i && dragIndex !== i;
              return (
                <div
                  key={pin.id}
                  className={`ticker-setup-row${isDragging ? ' is-dragging' : ''}${isDragOver ? ' drag-over' : ''}`}
                  draggable
                  onDragStart={e => handleDragStart(e, i)}
                  onDragOver={e  => handleDragOver(e, i)}
                  onDrop={e      => handleDrop(e, i)}
                  onDragEnd={handleDragEnd}
                  onDragLeave={() => { if (dragOverIndex === i) setDragOverIndex(null); }}
                >
                  <span
                    className="ticker-setup-drag-handle"
                    title="Drag to reorder this pin within the layout"
                    aria-hidden="true"
                  >⠿</span>

                  <div className="ticker-setup-info">
                    <span className="ticker-setup-label">{pin.label}</span>
                    <span className="ticker-setup-meta">
                      {PIN_TYPE_LABELS[pin.type] ?? pin.type}
                      {pin.hubName && ` · ${pin.hubName}`}
                    </span>
                    {slot && !slot.loading && (
                      <span className={`ticker-setup-live ticker-color-${slot.colorClass}`}>
                        {slot.primaryText}
                        {slot.secondaryText && <span className="ticker-dim"> {slot.secondaryText}</span>}
                      </span>
                    )}
                  </div>

                  {groups.length > 1 && (
                    <select
                      className="ticker-pin-move-select"
                      value={pin.groupId}
                      onChange={e => movePin(pin.id, e.target.value)}
                      title="Move this pin to a different layout without removing it"
                      aria-label="Move pin to layout"
                    >
                      {groups.map(g => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    className="ticker-setup-remove"
                    onClick={() => onRemove(pin.id)}
                    aria-label={`Remove ${pin.label}`}
                    title="Remove this pin from the ticker permanently (you can re-add it any time with ⊕)"
                  >✕</button>
                </div>
              );
            })}
          </div>
        )}

        <div className="ticker-setup-footer">
          <span className="ticker-setup-hint">
            Drag <span style={{ opacity: 0.6 }}>⠿</span> to reorder.
            {groups.length > 1 && ' New ⊕ pins go to the active layout tab.'}
            {groups.length < 2 && ' Add a second layout to enable dual-row mode.'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default TickerSetup;
