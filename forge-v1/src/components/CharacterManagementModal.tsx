// FORGE — Character Management Modal
// Lets the user add characters, remove alts, and promote an alt to primary.

import { useState, type FC } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { CharacterInfo, AltCharacter, RememberedCharacter } from '../types';

interface CharacterManagementModalProps {
  character:         CharacterInfo;
  altCharacters:     AltCharacter[];
  addingAlt:         boolean;
  onAddCharacter:    () => void;
  onRemoveCharacter: (characterId: number) => void;
  onMakePrimary:     (characterId: number) => void;
  onClose:           () => void;
  /** "Remember my characters" — undefined while still loading from the server */
  rememberEnabled?:      boolean;
  rememberConfigured?:   boolean;
  rememberedCharacters?: RememberedCharacter[];
  onSetRemember?:        (enabled: boolean) => void;
  onForgetRemembered?:   (characterId: number) => void;
  /** Instantly reload a remembered character without an SSO redirect */
  onRestoreRemembered?:  (characterIds: number[]) => void;
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
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
    color: 'var(--color-accent-primary)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--color-text-secondary)',
    fontSize: 18,
    lineHeight: 1,
    padding: 2,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
    color: 'var(--color-text-secondary)',
    marginBottom: 8,
    marginTop: 16,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    background: 'var(--color-bg-secondary)',
    borderRadius: 6,
    marginBottom: 6,
  },
  portrait: {
    width: 40,
    height: 40,
    borderRadius: 4,
    flexShrink: 0 as const,
  },
  charName: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  badge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    color: 'var(--color-accent-primary)',
    background: 'rgba(var(--color-accent-rgb, 180,160,80), 0.15)',
    borderRadius: 3,
    padding: '2px 5px',
    flexShrink: 0 as const,
  },
  actionBtn: {
    background: 'none',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    padding: '3px 8px',
    color: 'var(--color-text-secondary)',
    flexShrink: 0 as const,
    transition: 'border-color 0.15s, color 0.15s',
  },
  removeBtn: {
    background: 'none',
    border: '1px solid transparent',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    padding: '3px 8px',
    color: 'var(--color-text-secondary)',
    flexShrink: 0 as const,
  },
  addBtn: {
    width: '100%',
    marginTop: 16,
    padding: '9px 0',
    background: 'none',
    border: '1px dashed var(--color-border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    letterSpacing: 0.3,
  },
  doneBtn: {
    width: '100%',
    marginTop: 10,
    padding: '9px 0',
    background: 'var(--color-accent-primary)',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--color-bg-primary)',
    letterSpacing: 0.3,
  },
};

const CharacterManagementModal: FC<CharacterManagementModalProps> = ({
  character,
  altCharacters,
  addingAlt,
  onAddCharacter,
  onRemoveCharacter,
  onMakePrimary,
  onClose,
  rememberEnabled,
  rememberConfigured = true,
  rememberedCharacters = [],
  onSetRemember,
  onForgetRemembered,
  onRestoreRemembered,
}) => {
  const [restoringId, setRestoringId] = useState<number | null>(null);
  useEscapeKey(onClose);

  // Characters we remember but that aren't loaded into this session right now —
  // those already loaded show above with their own Make Primary / × controls.
  const loadedIds = new Set(altCharacters.map((a) => a.characterId));
  const notYetLoaded = rememberedCharacters.filter((c) => !loadedIds.has(c.characterId));

  // Clear the "Loading…" state as soon as the restored character actually
  // shows up in altCharacters (the 15s timeout below is just a fallback for
  // a restore that silently failed).
  if (restoringId != null && loadedIds.has(restoringId)) setRestoringId(null);

  const handleRestore = (characterId: number) => {
    setRestoringId(characterId);
    onRestoreRemembered?.([characterId]);
    // No completion callback from the parent — clear the spinner state once the
    // alt shows up in altCharacters (handled by the effect below) or after a
    // generous timeout so a failed restore doesn't spin forever.
    window.setTimeout(() => setRestoringId((id) => (id === characterId ? null : id)), 15000);
  };

  return (
    <div style={S.overlay} role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label="Manage Characters">

        <div style={S.header}>
          <span style={S.title}>Characters</span>
          <button type="button" style={S.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* ── Remember my characters ─────────────────────────────────────── */}
        {rememberConfigured && onSetRemember && (
          <div className="push-toggle-row" style={{ marginBottom: 4 }}>
            <span className="push-toggle-label">🔑 Remember my characters</span>
            <button
              type="button"
              className={`push-toggle${rememberEnabled ? ' on' : ''}`}
              onClick={() => onSetRemember(!rememberEnabled)}
              aria-pressed={!!rememberEnabled}
              title={rememberEnabled
                ? 'Click to stop remembering — this also forgets every remembered character immediately'
                : 'Click to have FORGE securely remember alts you add from now on, so you don’t have to re-add them next session'}
            >
              <span className="push-toggle-thumb" />
              <span className="push-toggle-text">{rememberEnabled ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        )}
        {rememberConfigured && (
          <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 16, lineHeight: 1.4 }}>
            {rememberEnabled
              ? 'FORGE will remember alts you add from here on and offer to reload them next time your main logs in. Turning this off immediately forgets all of them.'
              : 'When on, alts you add are remembered securely so you can reload them next session instead of re-adding each one via EVE SSO.'}
          </div>
        )}

        {/* Remembered characters not currently loaded this session */}
        {notYetLoaded.length > 0 && (
          <>
            <div style={{ ...S.sectionLabel, marginTop: 4 }}>Remembered — not loaded</div>
            {notYetLoaded.map((rc) => (
              <div key={rc.characterId} style={S.card}>
                <img
                  src={`https://images.evetech.net/characters/${rc.characterId}/portrait?size=64`}
                  alt={rc.name}
                  style={{ ...S.portrait, opacity: 0.6 }}
                />
                <span style={S.charName}>{rc.name}</span>
                {rc.needsReauth && (
                  <span style={{ ...S.badge, color: 'var(--color-danger, #c0392b)' }} title="EVE now requires permissions this character wasn't added with — remove and re-add it via + Add Character">
                    Re-auth needed
                  </span>
                )}
                <button
                  type="button"
                  style={S.actionBtn}
                  disabled={restoringId === rc.characterId || rc.needsReauth}
                  onClick={() => handleRestore(rc.characterId)}
                  title={rc.needsReauth ? 'Needs re-authorisation — use + Add Character instead' : 'Load this character now, no EVE SSO redirect needed'}
                >
                  {restoringId === rc.characterId ? 'Loading…' : 'Load'}
                </button>
                <button
                  type="button"
                  style={S.removeBtn}
                  onClick={() => onForgetRemembered?.(rc.characterId)}
                  title="Forget this character permanently"
                >
                  Forget
                </button>
              </div>
            ))}
          </>
        )}

        {/* Primary character */}
        <div style={{ ...S.sectionLabel }}>Primary</div>
        <div style={S.card}>
          <img
            src={`https://images.evetech.net/characters/${character.characterId}/portrait?size=64`}
            alt={character.name}
            style={S.portrait}
          />
          <span style={S.charName}>{character.name}</span>
          <span style={S.badge}>Primary</span>
        </div>

        {/* Alt characters */}
        {altCharacters.length > 0 && (
          <>
            <div style={{ ...S.sectionLabel, marginTop: 20 }}>Alt Characters</div>
            {altCharacters.map((alt) => (
              <div key={alt.characterId} style={S.card}>
                <img
                  src={`https://images.evetech.net/characters/${alt.characterId}/portrait?size=64`}
                  alt={alt.name}
                  style={S.portrait}
                />
                <span style={S.charName}>
                  {alt.loading ? <em style={{ color: 'var(--color-text-secondary)' }}>Loading…</em> : alt.name}
                </span>
                {!alt.loading && (
                  <>
                    <button
                      type="button"
                      style={S.actionBtn}
                      onClick={() => onMakePrimary(alt.characterId)}
                      title="Make this character your primary"
                    >
                      Make Primary
                    </button>
                    <button
                      type="button"
                      style={S.removeBtn}
                      onClick={() => onRemoveCharacter(alt.characterId)}
                      title="Remove this alt"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
          </>
        )}

        {/* Add character */}
        <button
          type="button"
          style={S.addBtn}
          disabled={addingAlt}
          onClick={onAddCharacter}
        >
          {addingAlt ? 'Redirecting to EVE SSO…' : '+ Add Character'}
        </button>

        {/* Every action in this modal (toggle, add, remove, make primary,
            forget) already takes effect immediately via its own API call —
            there's nothing separate to "save". Done is just a clearly-labelled
            second way to close, alongside the × in the header. */}
        <button type="button" style={S.doneBtn} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
};

export default CharacterManagementModal;
