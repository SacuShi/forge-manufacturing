/**
 * FORGE v1.0 — Header component
 *
 * Top 48px application bar. Layout (left → right):
 *
 *   LEFT:
 *     [◈ FORGE logo]  [Dashboard btn]  [F.O.R.G.E. AI toggle btn]
 *
 *   RIGHT:
 *     [◎ Jita 4-4 ▾ (teaser)]  [Character pill]  [Logout btn ← extra gap]
 *
 * The F.O.R.G.E. AI button uses .btn-chat and gains the .open modifier
 * class when the chat panel is open, visually receding (inset shadow)
 * to signal the active/depressed state.
 *
 * The Logout button gets .btn-logout which adds margin-left: 16px via CSS,
 * providing double the gap versus other header buttons.
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
  /** Whether the chat panel is currently open */
  chatOpen: boolean;
  /** Called when the F.O.R.G.E. AI toggle button is clicked */
  onToggleChat: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PORTRAIT_BASE = 'https://images.evetech.net/characters';

// ── Component ────────────────────────────────────────────────────────────────

const Header: FC<HeaderProps> = ({ character, chatOpen, onToggleChat }) => {
  const portraitUrl = `${PORTRAIT_BASE}/${character.characterId}/portrait?size=32`;

  return (
    <header className="header" role="banner">

      {/* ── Left group ──────────────────────────────────────────────────────── */}
      <div className="header-left">

        {/* Logo mark */}
        <span className="logo" aria-label="FORGE Manufacturing Intelligence">
          <span className="logo-icon" aria-hidden="true" />
          FORGE
        </span>

        {/* Dashboard nav button — active by default in v1.0 */}
        <button
          type="button"
          className="btn active"
          aria-current="page"
        >
          Dashboard
        </button>

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

        {/* Market region selector — teaser for v1.1, not interactive */}
        <span
          className="market-teaser"
          role="note"
          aria-label="Market region: Jita 4-4 (region selector coming in v1.1)"
        >
          ◎ Jita 4-4 ▾
        </span>

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

        {/* Logout — .btn-logout CSS adds the extra left margin gap */}
        <button type="button" className="btn btn-logout" aria-label="Log out of FORGE">
          Logout
        </button>

      </div>
    </header>
  );
};

export default Header;
