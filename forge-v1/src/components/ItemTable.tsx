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
import {
  formatISK,
  formatISKPerHour,
  formatMargin,
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
}

interface ColDef {
  label: string;
  /** Null means column is not sortable */
  field: SortField | null;
  align?: 'right' | 'center';
}

// ── Constants ────────────────────────────────────────────────────────────────

const ICON_BASE = 'https://images.evetech.net/types';

const COLUMNS: ColDef[] = [
  { label: '#',          field: 'rank',            align: 'center' },
  { label: 'Item',       field: null                               },
  { label: 'Profit/Run', field: 'profitPerRun',    align: 'right'  },
  { label: 'Margin',     field: 'margin',           align: 'right'  },
  { label: 'ISK/hr',     field: 'iskPerHour',       align: 'right'  },
  { label: 'Build Time', field: 'buildTimeMinutes', align: 'right'  },
  { label: 'Owned',      field: null,               align: 'center' },
  { label: 'Action',     field: null,               align: 'center' },
];

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
}) => (
  <div className="table-wrap" role="region" aria-label="Market opportunities table">
    <table>
      <thead>
        <tr>
          {COLUMNS.map((col) => {
            const isSorted  = col.field === sortField;
            const ariaSort  = isSorted
              ? (sortDirection === 'asc' ? 'ascending' : 'descending')
              : undefined;
            const alignClass = col.align ? `align-${col.align}` : '';

            return (
              <th
                key={col.label}
                className={alignClass}
                aria-sort={ariaSort}
                onClick={col.field ? () => onSort(col.field!) : undefined}
                style={col.field ? undefined : { cursor: 'default' }}
                scope="col"
              >
                {col.label}
                {isSorted && (
                  <span aria-hidden="true">
                    {' '}{sortDirection === 'asc' ? '↑' : '↓'}
                  </span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>

      <tbody>
        {items.map((item) => {
          const isSelected  = item.typeId === selectedTypeId;
          const iconUrl     = `${ICON_BASE}/${item.typeId}/icon?size=32`;
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

              {/* Owned badge */}
              <td className="align-center">
                <span className={ownedBadgeClass(item.owned)}>{item.owned}</span>
              </td>

              {/* Row action button */}
              <td className="align-center">
                <button
                  type="button"
                  className={`row-action${item.canBuild ? '' : ' skip'}`}
                  onClick={(e) => {
                    e.stopPropagation(); /* Prevent row click from also firing */
                    onSelect(item.typeId);
                  }}
                  aria-label={
                    item.canBuild
                      ? `Start build for ${item.name}`
                      : `${item.name} — cannot build`
                  }
                >
                  {item.canBuild ? 'Build' : 'Skip'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export default ItemTable;
