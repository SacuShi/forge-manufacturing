// FORGE — Remembered Characters restore prompt
// Shown once per browser session, right after the main character logs in,
// when the server has one or more alts remembered under this main and
// "Remember my characters" is on. Lets the user pick which ones to reload
// instantly (no EVE SSO redirect) instead of re-adding every alt by hand.

import { useState, useEffect, type FC } from 'react';
import type { RememberedCharacter } from '../types';

interface RememberedCharactersModalProps {
  characters: RememberedCharacter[];
  onLoad:     (characterIds: number[]) => void;
  /** Close without loading anyone — whatever's checked is simply not acted on */
  onDone:      () => void;
  onForgetAll: () => void;
}

const S = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    padding: '24px 28px',
    width: 420,
    maxWidth: '90vw',
    maxHeight: '80vh',
    overflowY: 'auto' as const,
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
    color: 'var(--color-accent-primary)',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 11,
    color: 'var(--color-text-secondary)',
    marginBottom: 18,
    lineHeight: 1.4,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: 'var(--color-bg-secondary)',
    borderRadius: 6,
    marginBottom: 6,
  },
  portrait: {
    width: 36,
    height: 36,
    borderRadius: 4,
    flexShrink: 0 as const,
  },
  name: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  lastUsed: {
    fontSize: 10,
    color: 'var(--color-text-tertiary)',
    flexShrink: 0 as const,
  },
  reauthBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: 'var(--color-danger, #c0392b)',
    flexShrink: 0 as const,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 18,
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 10,
    color: 'var(--color-text-tertiary)',
    textDecoration: 'underline',
  },
  primaryBtn: {
    background: 'var(--color-accent-primary)',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    padding: '8px 16px',
    color: 'var(--color-bg-primary)',
  },
  secondaryBtn: {
    background: 'none',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    padding: '8px 14px',
    color: 'var(--color-text-secondary)',
    marginRight: 8,
  },
};

function formatLastUsed(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const RememberedCharactersModal: FC<RememberedCharactersModalProps> = ({
  characters, onLoad, onDone, onForgetAll,
}) => {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(characters.filter((c) => !c.needsReauth).map((c) => c.characterId))
  );

  // Re-sync defaults if `characters` arrives/changes after this modal already
  // mounted (e.g. the parent's remember-list fetch resolves a beat later than
  // the modal itself appears) — a plain useState lazy initializer only runs
  // once on mount, so without this a late-arriving list could render with
  // nothing checked and no way to tell why.
  useEffect(() => {
    setSelected(new Set(characters.filter((c) => !c.needsReauth).map((c) => c.characterId)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={S.overlay}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label="Reload remembered characters">
        <div style={S.title}>Welcome back</div>
        <div style={S.subtitle}>
          FORGE remembers {characters.length} character{characters.length === 1 ? '' : 's'} from last time.
          Pick which ones to reload now — no EVE SSO redirect needed.
        </div>

        {characters.map((c) => (
          <label key={c.characterId} style={{ ...S.row, cursor: c.needsReauth ? 'not-allowed' : 'pointer', opacity: c.needsReauth ? 0.55 : 1 }}>
            <input
              type="checkbox"
              checked={selected.has(c.characterId)}
              disabled={c.needsReauth}
              onChange={() => toggle(c.characterId)}
            />
            <img
              src={`https://images.evetech.net/characters/${c.characterId}/portrait?size=64`}
              alt={c.name}
              style={S.portrait}
            />
            <span style={S.name}>{c.name}</span>
            {c.needsReauth
              ? <span style={S.reauthBadge} title="EVE now requires permissions this character wasn't added with — remove and re-add it via + Add Character">RE-AUTH NEEDED</span>
              : <span style={S.lastUsed}>{formatLastUsed(c.lastUsedAt)}</span>}
          </label>
        ))}

        <div style={S.footer}>
          <button type="button" style={S.linkBtn} onClick={onForgetAll}>
            Forget all
          </button>
          <div>
            <button type="button" style={S.secondaryBtn} onClick={onDone}>
              Done
            </button>
            <button
              type="button"
              style={{ ...S.primaryBtn, opacity: selected.size === 0 ? 0.5 : 1 }}
              disabled={selected.size === 0}
              onClick={() => onLoad([...selected])}
            >
              Load selected ({selected.size})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RememberedCharactersModal;
