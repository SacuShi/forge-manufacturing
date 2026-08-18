// FORGE — Character Management Modal
// Lets the user add characters, remove alts, and promote an alt to primary.

import type { FC } from 'react';
import type { CharacterInfo, AltCharacter } from '../types';

interface CharacterManagementModalProps {
  character:         CharacterInfo;
  altCharacters:     AltCharacter[];
  addingAlt:         boolean;
  onAddCharacter:    () => void;
  onRemoveCharacter: (characterId: number) => void;
  onMakePrimary:     (characterId: number) => void;
  onClose:           () => void;
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
    color: 'var(--color-accent)',
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
    color: 'var(--color-accent)',
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
};

const CharacterManagementModal: FC<CharacterManagementModalProps> = ({
  character,
  altCharacters,
  addingAlt,
  onAddCharacter,
  onRemoveCharacter,
  onMakePrimary,
  onClose,
}) => {
  return (
    <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label="Manage Characters">

        <div style={S.header}>
          <span style={S.title}>Characters</span>
          <button type="button" style={S.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

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
      </div>
    </div>
  );
};

export default CharacterManagementModal;
