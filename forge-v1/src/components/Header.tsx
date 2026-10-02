/**
 * FORGE v1.0 — Header component
 *
 * Top 48px application bar. Layout (left → right):
 *
 *   LEFT:
 *     [☰ menu btn (mobile only)]  [◈ FORGE logo]  [F.O.R.G.E. AI toggle]
 *
 *   RIGHT:
 *     [Source: ◎ <hub>]  [Market: ◎ <hub>]  [⚙ Mfg Setup]  [☀/🌙]  [Character pill]  [Logout]
 *
 * v1.3.0: Two MarketSelector dropdowns — Source (material purchase hub) and
 * Market (sell hub). They are independent: Source defaults to Jita and is
 * persisted in localStorage; Market drives the Market Opportunities table.
 *
 * Security:
 *   - Portrait URL uses numeric characterId only.
 *   - No dangerouslySetInnerHTML.
 */

import type { FC } from 'react';
import type { CharacterInfo, Market } from '../types';
import { MarketSelector } from './MarketSelector';
import forgeLogo from '../assets/forge-logo.png';

// ── Types ────────────────────────────────────────────────────────────────────

interface HeaderProps {
  character:             CharacterInfo;
  chatOpen:              boolean;
  theme:                 string;
  font:                  string;
  /** Sell hub — drives Market Opportunities table and sell-price calculations */
  selectedMarket:        Market;
  regionLoading:         boolean;
  /** Source hub — where raw materials are purchased */
  selectedSourceMarket:  Market;
  /**
   * Name of the manufacturing solar system saved in Industry Settings.
   * Null when the user hasn't configured a system yet.
   * Displayed read-only in the header bar so the active setup is always visible.
   */
  mfgSystemName:         string | null;
  onToggleChat:          () => void;
  onMenuToggle:          () => void;
  onThemeChange:         (theme: string) => void;
  onFontChange:          (font: string) => void;
  onLogout:              () => void;
  onMarketChange:        (market: Market) => void;
  onSourceMarketChange:  (market: Market) => void;
  onOpenSettings:        () => void;
  canDockKeestar:        boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PORTRAIT_BASE = 'https://images.evetech.net/characters';

// ── Component ────────────────────────────────────────────────────────────────

const Header: FC<HeaderProps> = ({
  character,
  chatOpen,
  theme,
  font,
  selectedMarket,
  regionLoading,
  selectedSourceMarket,
  mfgSystemName,
  onToggleChat,
  onMenuToggle,
  onThemeChange,
  onFontChange,
  onLogout,
  onMarketChange,
  onSourceMarketChange,
  onOpenSettings,
  canDockKeestar,
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

        {/* Logo mark with backronym */}
        <div className="forge-logo-container" aria-label="FORGE Manufacturing Intelligence">
          <div className="forge-logo">
            <img src={forgeLogo} alt="" className="forge-icon" width={24} height={24} />
            <span className="forge-text">FORGE</span>
          </div>
          <div className="forge-backronym">
            <span className="forge-letter">F</span>abrication,{' '}
            <span className="forge-letter">O</span>perations,{' '}
            <span className="forge-letter">R</span>esource &{' '}
            <span className="forge-letter">G</span>uidance{' '}
            <span className="forge-letter">E</span>ngine
          </div>
        </div>

        {/* F.O.R.G.E. AI panel toggle */}
        <button
          type="button"
          className={`btn-chat${chatOpen ? ' open' : ''}`}
          aria-pressed={chatOpen}
          aria-label={chatOpen ? 'Close F.O.R.G.E. AI advisor' : 'Open F.O.R.G.E. AI advisor'}
          onClick={onToggleChat}
        >
          Ask F.O.R.G.E. AI
        </button>

      </div>

      {/* ── Right group ─────────────────────────────────────────────────────── */}
      <div className="header-right">

        {/* ── Hub selectors ───────────────────────────────────────────────
             Source = where materials are purchased (default Jita)
             Market = where finished goods are sold (drives the table)      */}
        <div className="market-selector-group"
             title="Materials: where you buy ingredients · Market: where you sell finished goods">
          <MarketSelector
            label="Buy in"
            ariaLabel="Materials procurement hub"
            selectedMarket={selectedSourceMarket}
            onMarketChange={onSourceMarketChange}
            hideKeestar={!canDockKeestar}
          />
          <MarketSelector
            label="Sell at"
            ariaLabel="Sell market hub"
            selectedMarket={selectedMarket}
            onMarketChange={onMarketChange}
            loading={regionLoading}
            hideKeestar={!canDockKeestar}
          />
        </div>

        {/* ── Manufacturing location display ──────────────────────────────
             Read-only indicator of the system saved in Industry Settings.
             Clicking the adjacent ⚙ Mfg Setup button lets the user change it. */}
        <div
          className="mfg-location-display"
          title={mfgSystemName
            ? `Manufacturing location: ${mfgSystemName} — click ⚙ Mfg Setup to change`
            : 'No manufacturing system configured — click ⚙ Mfg Setup to set one'}
          aria-label={mfgSystemName
            ? `Manufacturing location: ${mfgSystemName}`
            : 'Manufacturing location: not configured'}
        >
          <span className="mfg-location-label">Mfg Location:</span>
          <span className={`mfg-location-value${mfgSystemName ? '' : ' mfg-location-unset'}`}>
            {mfgSystemName ?? 'Not set'}
          </span>
        </div>

        {/* Manufacturing setup — opens IndustrySettings modal */}
        <button
          type="button"
          className="settings-btn"
          onClick={onOpenSettings}
          title="Configure your manufacturing system, structure type, rigs and facility tax for accurate True Profit"
          aria-label="Open manufacturing setup"
        >
          ⚙ Mfg Setup
        </button>

        {/* Display controls — theme + font */}
        <div className="header-display-controls">
          <select
            className="market-dropdown"
            value={theme}
            onChange={e => onThemeChange(e.target.value)}
            aria-label="Colour theme"
            title="Switch colour theme"
          >
            <option value="dark">🌙 Dark</option>
            <option value="light">☀️ Light</option>
          </select>

          <select
            className="market-dropdown"
            value={font}
            onChange={e => onFontChange(e.target.value)}
            aria-label="Font"
            title="Switch font"
          >
            <option value="forge">FORGE (mono)</option>
            <option value="inter">Inter</option>
            <option value="roboto">Roboto</option>
            <option value="lexend">Lexend (dyslexia-friendly)</option>
          </select>
        </div>

        {/* Character pill */}
        <div className="char-pill" role="status" aria-label={`Logged in as ${character.name}`}>
          <div className="char-pill-avatar">
            <img
              src={portraitUrl}
              alt=""
              width={22}
              height={22}
              crossOrigin="anonymous"
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
