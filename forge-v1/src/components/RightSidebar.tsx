/**
 * FORGE v1.0 — RightSidebar component
 *
 * Fixed 280px right panel showing the detail analysis for the selected item.
 * Renders an empty-state prompt when no item is selected.
 *
 * When populated, the panel has four sections:
 *   1. Hero       — large item icon, name, category, ownership badge
 *   2. Financials — sell price, material cost, profit/run, margin, ISK/hr
 *   3. Blueprint  — build time (more fields in v1.1: ME/TE levels, runs)
 *   4. Materials  — icon + name + quantity for each required material
 *
 * Security:
 *   - All icon URLs use numeric typeId only.
 *   - No dangerouslySetInnerHTML.
 */

import type { FC } from 'react';
import type { ItemDetail } from '../types';
import {
  formatISK,
  formatISKPerHour,
  formatMargin,
  marginColourClass,
  profitColourClass,
} from '../utils/format';

// ── Types ────────────────────────────────────────────────────────────────────

interface RightSidebarProps {
  /** Full detail record for the selected item, or null if nothing is selected */
  detail: ItemDetail | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const ICON_BASE = 'https://images.evetech.net/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ownedBadgeClass(owned: ItemDetail['owned']): string {
  if (owned === 'BPO') return 'badge badge-bpo';
  if (owned === 'BPC') return 'badge badge-bpc';
  return 'badge badge-none';
}

// ── Sub-components ───────────────────────────────────────────────────────────

/** A single labelled metric inside the detail panel */
const StatCard: FC<{ label: string; value: string; valueClass?: string }> = ({
  label,
  value,
  valueClass = '',
}) => (
  <div className="stat-card">
    <div className="stat-card-label">{label}</div>
    <div className={`stat-card-value${valueClass ? ` ${valueClass}` : ''}`}>{value}</div>
  </div>
);

// ── Component ────────────────────────────────────────────────────────────────

const RightSidebar: FC<RightSidebarProps> = ({ detail }) => {
  /* ── Empty state ─────────────────────────────────────────────────────────── */
  if (!detail) {
    return (
      <aside className="sidebar-right" aria-label="Item detail">
        <div className="detail-empty">
          <div className="detail-empty-icon" aria-hidden="true">⊕</div>
          <p>Select an item to see its profit analysis</p>
        </div>
      </aside>
    );
  }

  /* ── Populated state ─────────────────────────────────────────────────────── */
  const heroIconUrl = `${ICON_BASE}/${detail.typeId}/icon?size=64`;
  const profitClass = profitColourClass(detail.profitPerRun);
  const marginClass = marginColourClass(detail.margin);
  const iskHrClass  = profitColourClass(detail.iskPerHour);

  return (
    <aside className="sidebar-right" aria-label={`${detail.name} detail analysis`}>
      <div className="detail-panel">

        {/* ── Hero ────────────────────────────────────────────────────────── */}
        <div className="detail-hero">
          <div className="detail-icon">
            <img
              src={heroIconUrl}
              alt=""
              width={52}
              height={52}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          </div>
          <div>
            <div className="detail-item-name">{detail.name}</div>
            <div className="detail-item-cat">{detail.category}</div>
            <span className={ownedBadgeClass(detail.owned)}>{detail.owned}</span>
          </div>
        </div>

        {/* ── Financials ──────────────────────────────────────────────────── */}
        <div className="detail-section">
          <div className="detail-section-heading">Financials</div>
          <StatCard label="Sell Price"     value={formatISK(detail.sellPrice)} />
          <StatCard label="Material Cost"  value={formatISK(detail.matCost)} />
          <StatCard label="Profit / Run"   value={formatISK(detail.profitPerRun)}       valueClass={profitClass} />
          <StatCard label="Margin"         value={formatMargin(detail.margin)}           valueClass={marginClass} />
          <StatCard label="ISK / Hour"     value={formatISKPerHour(detail.iskPerHour)}   valueClass={iskHrClass}  />
        </div>

        {/* ── Blueprint ───────────────────────────────────────────────────── */}
        <div className="detail-section">
          <div className="detail-section-heading">Blueprint</div>
          <StatCard label="Build Time" value={detail.buildTime} />
        </div>

        {/* ── Materials ───────────────────────────────────────────────────── */}
        {detail.materials.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-heading">Materials</div>
            <div className="mat-list">
              {detail.materials.map((mat) => {
                const matIconUrl = `${ICON_BASE}/${mat.typeId}/icon?size=32`;
                return (
                  <div key={mat.typeId} className="mat-row">
                    <span className="mat-name">
                      <span className="mat-icon">
                        <img
                          src={matIconUrl}
                          alt=""
                          width={14}
                          height={14}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                          }}
                        />
                      </span>
                      {mat.name}
                    </span>
                    <span className="mat-qty">{mat.quantity}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Footer action ────────────────────────────────────────────────── */}
        <div className="detail-footer">
          <button
            type="button"
            className="btn"
            style={{ width: '100%' }}
            aria-label={`Analyse T2 production chain for ${detail.name}`}
          >
            Analyse T2 Chain →
          </button>
        </div>

      </div>
    </aside>
  );
};

export default RightSidebar;
