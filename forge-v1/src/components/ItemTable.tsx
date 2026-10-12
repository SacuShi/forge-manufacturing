/**
 * FORGE v1.0 — ItemTable component
 *
 * Sortable data table listing market items with key profit metrics.
 *
 * Columns:
 *   # | Item (icon + name + category) | Profit/Run | Margin | ISK/hr
 *   | Build Time | Owned | Action
 *
 * Sort state is owned by the parent (MainContent) so the filter row
 * and the table share a single source of truth without prop drilling.
 *
 * Accessibility:
 *   - aria-sort on <th> reflects current sort direction.
 *   - aria-selected on <tr> reflects selection state.
 *   - The "Build / Skip" row-action button stops click propagation so it
 *     doesn't double-fire the row's own onClick handler.
 *
 * Security:
 *   - Icon URLs are constructed from numeric typeIds only.
 *   - No dangerouslySetInnerHTML anywhere.
 */

import type { FC } from 'react';
import type { MarketItem, SortField, SortDirection } from '../types';
import TickerPinButton from './TickerPinButton';
import {
  formatISK,
  formatISKPerHour,
  formatMargin,
  formatPerDay,
  liquidityInfo,
  marginColourClass,
  profitColourClass,
} from '../utils/format';

// ── Types ────────────────────────────────────────────────────────────────────

interface ItemTableProps {
  items: MarketItem[];
  selectedTypeId: number | null;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  onSelect: (typeId: number) => void;
  showHaulColumn?: boolean;
  /** regionId of the currently selected market hub (for ticker pin context) */
  regionId?: number;
  hubName?: string;
}

interface ColDef {
  label: string;
  /** Null means column is not sortable */
  field: SortField | null;
  align?: 'right' | 'center';
  /** Hover hint shown on the column header */
  hint?: string;
}

// Column header tooltips — visible on hover, explain what each number means.
const GROSS_HINT =
  'Est. Gross — sell price minus raw material cost, before broker fees, sales tax, or job costs. ' +
  'Uses an ME 0 blueprint. A rough ranking baseline only — open an item for your real net profit.';

const MARGIN_HINT =
  'Margin — gross profit as a percentage of sell price. Higher margin = more buffer if prices move against you. ' +
  'Below 5% is very thin. 10–20% is healthy. Above 30% often means low volume or high competition risk.';

const ISKHR_HINT =
  'Est. ISK/hr — gross profit normalised by build time. Usually the best column to sort by: a slow battleship ' +
  'with 50M profit/run may lose to a fast module with 3M profit/run × many jobs per hour. ' +
  'Open an item to see your true ISK/hr after fees and your blueprint ME.';

// Liquidity column: how much the market actually absorbs per day. A fat margin on a
// 2/day item is a trap — you crater your own price trying to offload a batch.
const VOL_HINT =
  'Sellable/day — mean units traded on the market (30-day history). High margin + low ' +
  'volume = slow to liquidate. Dot: green liquid · amber thin · grey contract-only · red suspect.';

const BUILDTIME_HINT =
  'Build time for one manufacturing job at your configured structure and rigs. ' +
  'Shorter build times let you queue more jobs per day and compound your ISK/hr.';

const OWNED_HINT =
  'Whether you own a blueprint for this item. BPO = Blueprint Original (permanent, researchable). ' +
  'BPC = Blueprint Copy (limited runs). No badge = you need to buy a BPC from contracts or the LP store.';

// ── Constants ────────────────────────────────────────────────────────────────

import { itemIconUrl } from '../utils/icons';

const BASE_COLUMNS: ColDef[] = [
  { label: '#',            field: 'rank',            align: 'center' },
  { label: 'Item',         field: null                               },
  { label: 'Est. Gross',   field: 'profitPerRun',    align: 'right', hint: GROSS_HINT   },
  { label: 'Margin',       field: 'margin',          align: 'right', hint: MARGIN_HINT  },
  { label: 'Est. ISK/hr',  field: 'iskPerHour',      align: 'right', hint: ISKHR_HINT   },
  { label: 'Build Time',   field: 'buildTimeMinutes',align: 'right', hint: BUILDTIME_HINT },
  { label: 'Sellable/day', field: 'avgDailyVolume',  align: 'right', hint: VOL_HINT     },
  { label: 'Owned',        field: null,              align: 'center', hint: OWNED_HINT  },
  { label: 'Action',       field: null,              align: 'center' },
];

const HAUL_COLUMN: ColDef = { label: 'Haul/unit', field: null, align: 'right' };

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Maps OwnedStatus to the matching badge CSS modifier class */
function ownedBadgeClass(owned: MarketItem['owned']): string {
  if (owned === 'BPO') return 'badge badge-bpo';
  if (owned === 'BPC') return 'badge badge-bpc';
  return 'badge badge-none';
}

// ── Component ────────────────────────────────────────────────────────────────

const ItemTable: FC<ItemTableProps> = ({
  items,
  selectedTypeId,
  sortField,
  sortDirection,
  onSort,
  onSelect,
  showHaulColumn = false,
  regionId,
  hubName,
}) => {
  // Insert Haul/unit before 'Owned' when enabled
  const columns = showHaulColumn
    ? [...BASE_COLUMNS.slice(0, 6), HAUL_COLUMN, ...BASE_COLUMNS.slice(6)]
    : BASE_COLUMNS;

  return (
  <div className="table-wrap" role="region" aria-label="Market opportunities table">
    <table>
      <thead>
        <tr>
          {columns.map((col) => {
            const isSorted  = col.field === sortField;
            const ariaSort  = isSorted
              ? (sortDirection === 'asc' ? 'ascending' : 'descending')
              : undefined;
            const alignClass = col.align && !col.field ? `align-${col.align}` : '';

            return (
              <th
                key={col.label}
                className={alignClass}
                aria-sort={ariaSort}
                scope="col"
              >
                {col.field ? (
                  <button
                    type="button"
                    className={`col-sort-btn${isSorted ? ' col-sort-active' : ''}`}
                    onClick={() => onSort(col.field!)}
                    title={col.hint}
                    aria-pressed={isSorted}
                  >
                    {col.label}{isSorted && <span className="sort-arrow">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                ) : (
                  <span title={col.hint}>{col.label}</span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>

      <tbody>
        {items.map((item) => {
          const isSelected  = item.typeId === selectedTypeId;
          const iconUrl     = itemIconUrl(item.typeId);
          const profitClass = profitColourClass(item.profitPerRun);
          const marginClass = marginColourClass(item.margin);
          const iskHrClass  = profitColourClass(item.iskPerHour);

          return (
            <tr
              key={item.typeId}
              aria-selected={isSelected}
              onClick={() => onSelect(item.typeId)}
            >
              {/* Rank */}
              <td className="rank-cell align-center">{item.rank}</td>

              {/* Item — icon + name + category */}
              <td>
                <div className="item-cell">
                  <div className="item-cell-icon">
                    <img
                      src={iconUrl}
                      alt=""
                      width={24}
                      height={24}
                      crossOrigin="anonymous"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                  </div>
                  <div>
                    <span className="item-cell-name">{item.name}</span>
                    <span className="item-cell-category">{item.category}</span>
                  </div>
                </div>
              </td>

              {/* Profit/Run */}
              <td className="align-right">
                <span className={`num ${profitClass}`}>
                  {formatISK(item.profitPerRun)}
                </span>
                {item.priceSource === 'jita_fallback' && (
                  <span
                    className="price-source-hist"
                    title="This hub has none listed for sale, so the sell price is Jita's current lowest sell (the sale is assumed at Jita)."
                  >J</span>
                )}
                {item.priceSource === 'history_30d' && (
                  <span
                    className="price-source-hist"
                    title={`No live sell orders — sell price estimated from 30-day trade average${item.avg30dPrice ? ` (~${formatISK(item.avg30dPrice)})` : ''}`}
                  >~</span>
                )}
              </td>

              {/* Margin */}
              <td className="align-right">
                <span className={`num ${marginClass}`}>
                  {formatMargin(item.margin)}
                </span>
              </td>

              {/* ISK/hr */}
              <td className="align-right">
                <span className={`num ${iskHrClass}`}>
                  {formatISKPerHour(item.iskPerHour)}
                </span>
              </td>

              {/* Build Time */}
              <td className="align-right">
                <span className="num">{item.buildTime}</span>
              </td>

              {/* Haul/unit — only rendered when showHaulColumn */}
              {showHaulColumn && (
                <td className="align-right">
                  {(item.haulCostPerUnit ?? 0) > 0 ? (
                    <div style={{ lineHeight: 1.3 }}>
                      <span className="num" style={{ color: 'var(--color-warning)', display: 'block' }}>
                        {formatISK(item.haulCostPerUnit ?? 0)}
                      </span>
                      {(item.haulIskPerM3 ?? 0) > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                          {Math.round(item.haulIskPerM3 ?? 0).toLocaleString()}/m³
                        </span>
                      )}
                    </div>
                  ) : (
                    <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>—</span>
                  )}
                </td>
              )}

              {/* Sellable/day — market liquidity (always present) */}
              {(() => {
                const liq = liquidityInfo(item.liquidityRisk);
                const isContract = item.liquidityRisk === 'contract_only';
                return (
                  <td className="align-right" title={liq.tip}>
                    <span className="vol-cell">
                      <span className={`liq-dot liq-${liq.dot}`} aria-hidden="true" />
                      <span className="num" style={{ color: 'var(--color-text-secondary)' }}>
                        {isContract ? 'contract' : formatPerDay(item.avgDailyVolume)}
                      </span>
                      {!isContract && item.volumeSource === 'jita' && (
                        <span
                          className="price-source-hist"
                          title="No trading data for this hub, so this is Jita's daily volume."
                        >J</span>
                      )}
                    </span>
                  </td>
                );
              })()}

              {/* Owned badge */}
              <td className="align-center">
                <span className={ownedBadgeClass(item.owned)}>{item.owned}</span>
              </td>

              {/* Row action button */}
              <td className="align-center">
                <div className="row-action-cell">
                  <button
                    type="button"
                    className={`row-action${item.canBuild ? '' : ' skip'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(item.typeId);
                    }}
                    aria-label={item.canBuild ? `Start build for ${item.name}` : `${item.name} — cannot build`}
                  >
                    {item.canBuild ? 'Build' : 'Skip'}
                  </button>
                  {regionId && (
                    <TickerPinButton
                      options={[
                        { type: 'mfg_profit',   label: `${item.name} profit (Gross)` },
                        { type: 'mfg_margin',   label: `${item.name} margin (Gross)` },
                        { type: 'mfg_isk_hour', label: `${item.name} ISK/hr (Gross)` },
                        { type: 'price_sell',   label: `${item.name} sell price` },
                      ]}
                      baseConfig={{ typeId: item.typeId, itemName: item.name, regionId, hubName }}
                    />
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
  );
};

export default ItemTable;
