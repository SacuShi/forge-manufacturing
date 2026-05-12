/**
 * FORGE v1.0 — LeftSidebar component
 *
 * Fixed 240px left panel showing:
 *   1. Character card — portrait, name, online indicator, wallet + job stats
 *   2. Quick Prompts — one-click preset questions that open the AI advisor
 *   3. Active Jobs   — list of in-progress manufacturing jobs with timers
 *
 * Quick prompt clicks propagate to App via onQuickPrompt, which opens the
 * chat panel and appends the prompt as a user message.
 *
 * Security:
 *   - Portrait URL uses numeric characterId only.
 *   - No dangerouslySetInnerHTML.
 */

import type { FC } from 'react';
import type { CharacterInfo } from '../types';
import { formatISK } from '../utils/format';
import { QUICK_PROMPTS } from '../data/mockData';

// ── Types ────────────────────────────────────────────────────────────────────

interface LeftSidebarProps {
  character: CharacterInfo;
  /** Called when a quick prompt button is clicked */
  onQuickPrompt: (prompt: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PORTRAIT_BASE = 'https://images.evetech.net/characters';

// ── Component ────────────────────────────────────────────────────────────────

const LeftSidebar: FC<LeftSidebarProps> = ({ character, onQuickPrompt }) => {
  const portraitUrl = `${PORTRAIT_BASE}/${character.characterId}/portrait?size=64`;

  return (
    <aside className="sidebar-left" aria-label="Character info and quick actions">

      {/* ── Character card ──────────────────────────────────────────────── */}
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

        <div className="stat-row">
          <span className="stat-label">Wallet</span>
          <span className="stat-value accent">{formatISK(character.walletISK)}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Active Jobs</span>
          <span className="stat-value">{character.activeJobCount}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Blueprints</span>
          <span className="stat-value">{character.blueprintCount}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">BPOs</span>
          <span className="stat-value">{character.bpoCount}</span>
        </div>
      </div>

      {/* ── Quick Prompts ────────────────────────────────────────────────── */}
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

      {/* ── Active Jobs ──────────────────────────────────────────────────── */}
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

    </aside>
  );
};

export default LeftSidebar;
