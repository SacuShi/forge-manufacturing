/**
 * FORGE v1.0 — LeftSidebar component
 *
 * Fixed 240px left panel. Contents:
 *   1. Character card with 2×2 stats grid (Wallet, Blueprints, BPOs, Active Jobs)
 *   2. Navigation — switches the active tab in MainContent
 *   3. Quick Prompts — opens and fills the AI chat
 *
 * Supports responsive drawer mode (mobile): slides in from the left when
 * drawerOpen is true, hidden otherwise via CSS.
 *
 * Security: portrait URL uses numeric characterId only.
 */

import type { FC } from 'react';
import type { CharacterInfo, EsiBlueprint } from '../types';
import { QUICK_PROMPTS } from '../data/mockData';

// ── Types ────────────────────────────────────────────────────────────────────

interface LeftSidebarProps {
  character: CharacterInfo;
  /** Live blueprint list from ESI (for accurate BPO count) */
  blueprints: EsiBlueprint[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  drawerOpen: boolean;
  onQuickPrompt: (prompt: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PORTRAIT_BASE = 'https://images.evetech.net/characters';

const NAV_ITEMS = [
  { key: 'market',      label: '◈ Market Opportunities' },
  { key: 'blueprints',  label: '◈ My Blueprints' },
  { key: 'assets',      label: '◉ My Assets' },
  { key: 'jobs',        label: '⚙ Active Jobs' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatISKShort(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return Math.round(n).toString();
}

// ── Component ────────────────────────────────────────────────────────────────

const LeftSidebar: FC<LeftSidebarProps> = ({
  character,
  blueprints,
  activeTab,
  onTabChange,
  drawerOpen,
  onQuickPrompt,
}) => {
  const portraitUrl = `${PORTRAIT_BASE}/${character.characterId}/portrait?size=64`;
  const bpoCount    = blueprints.filter((b) => b.quantity === -1).length;

  return (
    <aside
      className={`sidebar-left${drawerOpen ? ' drawer-open' : ''}`}
      aria-label="Character info and navigation"
    >

      {/* ── Character card ──────────────────────────────────────────────────── */}
      <div className="char-card">
        <div className="char-card-header">
          <div className="char-portrait">
            <img
              src={portraitUrl}
              alt={`${character.name} portrait`}
              width={36}
              height={36}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          </div>
          <div className="char-name-block">
            <div className="char-card-name">{character.name}</div>
            <div className="char-status">
              <span className="status-dot" aria-hidden="true" />
              Online
            </div>
          </div>
        </div>

        {/* 2×2 Stats grid */}
        <div className="stats-grid">
          <div className="stat-box">
            <div className="stat-box-label">Wallet</div>
            <div className="stat-box-value" style={{ color: 'var(--color-success)' }}>
              {formatISKShort(character.walletISK)}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-box-label">Blueprints</div>
            <div className="stat-box-value" style={{ color: 'var(--color-accent-primary)' }}>
              {blueprints.length}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-box-label">BPOs</div>
            <div className="stat-box-value" style={{ color: '#c084fc' }}>
              {bpoCount}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-box-label">Active Jobs</div>
            <div className="stat-box-value" style={{ color: 'var(--color-warning)' }}>
              {character.activeJobCount}
            </div>
          </div>
        </div>
      </div>

      {/* ── Navigation ──────────────────────────────────────────────────────── */}
      <div className="section-heading" aria-hidden="true">Navigation</div>
      <nav aria-label="Content tabs">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sidebar-nav-item${activeTab === item.key ? ' active' : ''}`}
            onClick={() => onTabChange(item.key)}
            aria-current={activeTab === item.key ? 'page' : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* ── Quick Prompts ────────────────────────────────────────────────────── */}
      <div className="section-heading" aria-hidden="true">Quick Prompts</div>
      <nav aria-label="Quick prompts">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="quick-btn"
            onClick={() => onQuickPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </nav>

      {/* ── Active Jobs ──────────────────────────────────────────────────────── */}
      {character.activeJobs.length > 0 && (
        <>
          <div className="section-heading" aria-hidden="true">Active Jobs</div>
          <ul style={{ listStyle: 'none' }} aria-label="Active manufacturing jobs">
            {character.activeJobs.map((job) => (
              <li key={`${job.name}-${job.remaining}`} className="job-row">
                <span className="job-name">
                  {job.quantity > 1 ? `×${job.quantity} ` : ''}{job.name}
                </span>
                <span className={`job-time${job.done ? ' done' : ''}`}>
                  {job.remaining}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

    </aside>
  );
};

export default LeftSidebar;
