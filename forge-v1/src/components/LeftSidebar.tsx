/**
 * FORGE v1.5 — LeftSidebar component
 *
 * Fixed 240px left panel. Contents:
 *   1. Character card with 2×2 stats grid (Wallet, Blueprints, BPOs, Active Jobs)
 *      v1.5: Wallet shows combined total across all in-scope characters when alts loaded.
 *   2. v1.5: Alt character cards with loading state and remove button.
 *   3. v1.5: View toggle — "All Characters" + per-character isolation chips.
 *   4. v1.5: "Add Character" button to trigger EVE SSO for an additional character.
 *   5. Navigation — switches the active tab in MainContent.
 *   6. Quick Prompts — opens and fills the AI chat.
 *   7. Active Jobs list (combined across all in-scope characters).
 *
 * Security: portrait URLs use numeric characterId only.
 */

import type { FC } from 'react';
import type { CharacterInfo, EsiBlueprint, AltCharacter, ActiveJob } from '../types';
import { QUICK_PROMPTS } from '../data/mockData';
import type { PushState } from '../hooks/usePushNotifications';
import TickerPinButton from './TickerPinButton';

// ── Types ────────────────────────────────────────────────────────────────────

interface LeftSidebarProps {
  character:          CharacterInfo;
  /** Combined blueprint list across in-scope characters (for BPO count) */
  blueprints:         EsiBlueprint[];
  activeTab:          string;
  onTabChange:        (tab: string) => void;
  drawerOpen:         boolean;
  onQuickPrompt:      (prompt: string) => void;
  // v1.5 — Multi-character props
  altCharacters:      AltCharacter[];
  addingAlt:          boolean;
  onAddCharacter:     () => void;
  onRemoveCharacter:  (characterId: number) => void;
  viewCharacterId:    number | null;
  onViewChange:       (characterId: number | null) => void;
  /** Combined total wallet across all in-scope characters */
  totalWalletISK:     number;
  pushState:          PushState;
  onPushEnable:       () => void;
  onPushDisable:      () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PORTRAIT_BASE = 'https://images.evetech.net/characters';

const NAV_ITEMS = [
  { key: 'market',      label: '◈ Market Opportunities' },
  { key: 'blueprints',  label: '◈ My Blueprints' },
  { key: 'research',    label: '🔬 Research ROI' },
  { key: 'assets',      label: '◉ My Assets' },
  { key: 'jobs',        label: '⚙ Active Jobs' },
  { key: 'queue',       label: '📋 Queue Planner' },
  { key: 'pi',          label: '🌍 PI Colonies' },
  { key: 'corp',        label: '🏭 Corp' },
  { key: 'trading',     label: '⟳ Station Trading' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatISKShort(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return Math.round(n).toString();
}

// Activity labels for job rows
const ACTIVITY_LABELS: Record<number, string> = {
  1: 'Mfg', 3: 'TE', 4: 'ME', 5: 'Copy', 8: 'Inv', 9: 'React', 11: 'RevEng',
};

// ── Sub-component: AltCard ────────────────────────────────────────────────────

interface AltCardProps {
  alt:          AltCharacter;
  isIsolated:   boolean;
  onIsolate:    () => void;
  onRemove:     () => void;
}

const AltCard: FC<AltCardProps> = ({ alt, isIsolated, onIsolate, onRemove }) => {
  const portraitUrl = `${PORTRAIT_BASE}/${alt.characterId}/portrait?size=32`;

  return (
    <div
      className={`alt-card${isIsolated ? ' isolated' : ''}`}
      role="button"
      tabIndex={0}
      title={alt.loading ? 'Loading…' : `Click to isolate ${alt.name}'s data`}
      onClick={onIsolate}
      onKeyDown={(e) => e.key === 'Enter' && onIsolate()}
    >
      {/* Portrait */}
      <div className="char-portrait" style={{ width: 28, height: 28, flexShrink: 0 }}>
        {alt.loading ? (
          <div className="loading-spinner" style={{ width: 20, height: 20, margin: '4px auto' }} />
        ) : (
          <img
            src={portraitUrl}
            alt={`${alt.name} portrait`}
            width={28}
            height={28}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
          />
        )}
      </div>

      {/* Info */}
      <div className="alt-card-info">
        <div className="alt-card-name">
          {alt.loading ? `Loading character…` : alt.name}
          {alt.error && (
            <span style={{ color: 'var(--color-danger)', fontSize: 9, marginLeft: 4 }}>⚠ Error</span>
          )}
        </div>
        {!alt.loading && !alt.error && (
          <div className="alt-card-stats">
            {formatISKShort(alt.walletISK)} · {alt.blueprintCount} BPs · {alt.activeJobCount} jobs
          </div>
        )}
        {alt.error && (
          <div className="alt-card-stats" style={{ color: 'var(--color-danger)' }}>
            {alt.error.length > 40 ? alt.error.slice(0, 40) + '…' : alt.error}
          </div>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        className="alt-card-remove"
        title={`Remove ${alt.name}`}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        aria-label={`Remove ${alt.name}`}
      >
        ×
      </button>
    </div>
  );
};

// ── Component ────────────────────────────────────────────────────────────────

const LeftSidebar: FC<LeftSidebarProps> = ({
  character,
  blueprints,
  activeTab,
  onTabChange,
  drawerOpen,
  onQuickPrompt,
  altCharacters,
  addingAlt,
  onAddCharacter,
  onRemoveCharacter,
  viewCharacterId,
  onViewChange,
  totalWalletISK,
  pushState,
  onPushEnable,
  onPushDisable,
}) => {
  const portraitUrl = `${PORTRAIT_BASE}/${character.characterId}/portrait?size=64`;
  const bpoCount    = blueprints.filter((b) => b.quantity === -1).length;
  const hasAlts     = altCharacters.length > 0;

  // Determine combined active job count across in-scope characters for the stat box
  const combinedJobCount = viewCharacterId === null
    ? character.activeJobCount + altCharacters.reduce((s, a) => s + a.activeJobCount, 0)
    : viewCharacterId === character.characterId
      ? character.activeJobCount
      : (altCharacters.find((a) => a.characterId === viewCharacterId)?.activeJobCount ?? 0);

  // Collect all active jobs from in-scope characters for the jobs list
  const visibleJobs: ActiveJob[] = (() => {
    if (viewCharacterId === null) {
      return [
        ...character.activeJobs,
        ...altCharacters.flatMap((a) => a.activeJobs),
      ];
    }
    if (viewCharacterId === character.characterId) return character.activeJobs;
    return altCharacters.find((a) => a.characterId === viewCharacterId)?.activeJobs ?? [];
  })();

  return (
    <aside
      className={`sidebar-left${drawerOpen ? ' drawer-open' : ''}`}
      aria-label="Character info and navigation"
    >

      {/* ── Primary character card ───────────────────────────────────────── */}
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

        {/* 2×2 Stats grid — wallet shows combined total when alts loaded */}
        <div className="stats-grid">
          <div className="stat-box">
            <div className="stat-box-label">
              {hasAlts ? 'Total ISK' : 'Wallet'}
              <TickerPinButton
                options={[{ type: 'wallet', label: 'Wallet ISK' }]}
                baseConfig={{}}
              />
            </div>
            <div className="stat-box-value" style={{ color: 'var(--color-success)' }}>
              {formatISKShort(totalWalletISK)}
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
            <div className="stat-box-label">
              Active Jobs
              <TickerPinButton
                options={[
                  { type: 'jobs_count', label: 'Active jobs' },
                  { type: 'jobs_next',  label: 'Next job' },
                ]}
                baseConfig={{}}
              />
            </div>
            <div className="stat-box-value" style={{ color: 'var(--color-warning)' }}>
              {combinedJobCount}
            </div>
          </div>
        </div>
      </div>

      {/* ── Ticker hint ──────────────────────────────────────────────────── */}
      <div className="ticker-sidebar-hint">
        <span className="ticker-sidebar-hint-pin">⊕</span>
        Hover any item to pin data to the live ticker bar below
      </div>

      {/* ── Alt characters section ───────────────────────────────────────── */}
      <div style={{ padding: '0 12px' }}>

        {/* Section heading with "Add" button inline */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 10, marginBottom: 6 }}>
          <div className="section-heading" style={{ margin: 0 }} aria-hidden="true">
            Characters
          </div>
          <button
            type="button"
            className="char-add-btn"
            style={{ width: 'auto', padding: '2px 8px', margin: 0, fontSize: 10 }}
            disabled={addingAlt}
            onClick={onAddCharacter}
            title="Add another EVE character"
            aria-label="Add another character"
          >
            {addingAlt ? '…' : '+ Add'}
          </button>
        </div>

        {/* View toggle — only shown when at least one alt is loaded */}
        {hasAlts && (
          <div className="char-view-toggle" role="group" aria-label="Character view scope">
            <button
              type="button"
              className={`pill-filter${viewCharacterId === null ? ' active' : ''}`}
              onClick={() => onViewChange(null)}
            >
              All
            </button>
            <button
              type="button"
              className={`pill-filter${viewCharacterId === character.characterId ? ' active' : ''}`}
              onClick={() => onViewChange(
                viewCharacterId === character.characterId ? null : character.characterId
              )}
              title={character.name}
            >
              {character.name.split(' ')[0]}
            </button>
            {altCharacters.map((alt) => (
              <button
                key={alt.characterId}
                type="button"
                className={`pill-filter${viewCharacterId === alt.characterId ? ' active' : ''}`}
                onClick={() => onViewChange(
                  viewCharacterId === alt.characterId ? null : alt.characterId
                )}
                title={alt.name}
                disabled={alt.loading}
              >
                {alt.loading ? '…' : alt.name.split(' ')[0]}
              </button>
            ))}
          </div>
        )}

        {/* Alt character cards */}
        {altCharacters.map((alt) => (
          <AltCard
            key={alt.characterId}
            alt={alt}
            isIsolated={viewCharacterId === alt.characterId}
            onIsolate={() => onViewChange(
              viewCharacterId === alt.characterId ? null : alt.characterId
            )}
            onRemove={() => {
              onRemoveCharacter(alt.characterId);
              // If this alt was isolated, revert to combined view
              if (viewCharacterId === alt.characterId) onViewChange(null);
            }}
          />
        ))}

        {/* "Add Character" full-width button (shown when no alts yet) */}
        {!hasAlts && (
          <button
            type="button"
            className="char-add-btn"
            disabled={addingAlt}
            onClick={onAddCharacter}
            aria-label="Add another EVE character"
          >
            {addingAlt ? 'Redirecting to EVE SSO…' : '+ Add Character'}
          </button>
        )}
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
      {visibleJobs.length > 0 && (
        <>
          <div className="section-heading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span aria-hidden="true">Active Jobs</span>
            <TickerPinButton
              options={[
                { type: 'jobs_next',  label: 'Next completing job' },
                { type: 'jobs_count', label: 'Active job count' },
              ]}
              baseConfig={{}}
            />
          </div>
          <ul style={{ listStyle: 'none' }} aria-label="Active manufacturing jobs">
            {visibleJobs.map((job, i) => (
              <li key={`${job.name}-${job.remaining}-${i}`} className="job-row">
                <span className="job-name">
                  {job.activityId && ACTIVITY_LABELS[job.activityId]
                    ? <span style={{ color: 'var(--color-text-tertiary)', marginRight: 4, fontSize: 9 }}>
                        [{ACTIVITY_LABELS[job.activityId]}]
                      </span>
                    : null}
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

      {/* ── Push Notifications ───────────────────────────────────────────────── */}
      {pushState !== 'unsupported' && (
        <div className="push-toggle-row">
          <span className="push-toggle-label">
            🔔 Job notifications
          </span>
          {pushState === 'denied' ? (
            <span
              className="push-toggle-blocked"
              title="Notifications are blocked in your browser — check your browser settings to allow them"
            >
              Blocked
            </span>
          ) : (
            <button
              type="button"
              className={`push-toggle${pushState === 'granted' ? ' on' : ''}`}
              onClick={pushState === 'granted' ? onPushDisable : onPushEnable}
              disabled={pushState === 'checking'}
              aria-pressed={pushState === 'granted'}
              title={pushState === 'granted'
                ? 'Click to disable job completion notifications'
                : 'Click to get notified when your industry jobs complete'}
            >
              <span className="push-toggle-thumb" />
              <span className="push-toggle-text">
                {pushState === 'checking' ? '…' : pushState === 'granted' ? 'ON' : 'OFF'}
              </span>
            </button>
          )}
        </div>
      )}

    </aside>
  );
};

export default LeftSidebar;
