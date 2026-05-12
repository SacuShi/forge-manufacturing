/**
 * FORGE v1.0 — Header component
 *
 * Top 48px application bar. Layout (left → right):
 *
 *   LEFT:
 *     [☰ menu btn (mobile only)]  [◈ FORGE logo]  [F.O.R.G.E. AI toggle]
 *
 *   RIGHT:
 *     [◎ Jita 4-4 teaser]  [☀/🌙 theme]  [Character pill]  [Logout]
 *
 * Security:
 *   - Portrait URL uses numeric characterId only.
 *   - No dangerouslySetInnerHTML.
 */

import type { FC } from 'react';
import type { CharacterInfo } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

interface HeaderProps {
  character: CharacterInfo;
  chatOpen: boolean;
  theme: string;
  onToggleChat: () => void;
  onMenuToggle: () => void;
  onThemeToggle: () => void;
  onLogout: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PORTRAIT_BASE = 'https://images.evetech.net/characters';

// ── Component ────────────────────────────────────────────────────────────────

const Header: FC<HeaderProps> = ({
  character,
  chatOpen,
  theme,
  onToggleChat,
  onMenuToggle,
  onThemeToggle,
  onLogout,
}) => {
  const portraitUrl = `${PORTRAIT_BASE}/${character.characterId}/portrait?size=32`;

  return (
    <header className="header" role="banner">

      {/* ── Left group ──────────────────────────────────────────────────────── */}
      <div className="header-left">

        {/* Mobile menu toggle — hidden on desktop via CSS */}
        <button
          type="button"
          className="menu-btn"
          aria-label="Toggle navigation menu"
          onClick={onMenuToggle}
        >
          ☰
        </button>

        {/* Logo mark */}
        <span className="logo" aria-label="FORGE Manufacturing Intelligence">
          <span className="logo-icon" aria-hidden="true" />
          FORGE
        </span>

        {/* F.O.R.G.E. AI panel toggle */}
        <button
          type="button"
          className={`btn-chat${chatOpen ? ' open' : ''}`}
          aria-pressed={chatOpen}
          aria-label={chatOpen ? 'Close F.O.R.G.E. AI advisor' : 'Open F.O.R.G.E. AI advisor'}
          onClick={onToggleChat}
        >
          ◈ F.O.R.G.E. AI
        </button>

      </div>

      {/* ── Right group ─────────────────────────────────────────────────────── */}
      <div className="header-right">

        {/* Market region teaser */}
        <span className="market-teaser" role="note" aria-label="Market: Jita 4-4">
          ◎ Jita 4-4 ▾
        </span>

        {/* Theme toggle */}
        <button
          type="button"
          className="btn"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={onThemeToggle}
          style={{ fontSize: 14, padding: '4px 8px' }}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        {/* Character pill */}
        <div className="char-pill" role="status" aria-label={`Logged in as ${character.name}`}>
          <div className="char-pill-avatar">
            <img
              src={portraitUrl}
              alt=""
              width={22}
              height={22}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          </div>
          <span className="char-pill-name">{character.name}</span>
        </div>

        {/* Logout */}
        <button
          type="button"
          className="btn btn-logout"
          aria-label="Log out of FORGE"
          onClick={onLogout}
        >
          Logout
        </button>

      </div>
    </header>
  );
};

export default Header;
