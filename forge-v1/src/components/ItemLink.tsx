/**
 * FORGE v1.0 — ItemLink component
 *
 * Renders an EVE item as a clickable inline element with its CCP icon.
 * Used in chat messages (parsed from [[Name|typeId]] tokens) and anywhere
 * an item needs to be represented as an interactive inline element.
 *
 * Security:
 *   - No dangerouslySetInnerHTML.
 *   - Icon URL is constructed from a numeric typeId only; no user-supplied
 *     strings are interpolated into URLs.
 *   - Rendered as <button> (not <a>) — it triggers a panel action, not
 *     navigation, so no href is needed and no open-redirect risk exists.
 */

import type { FC } from 'react';

interface ItemLinkProps {
  /** EVE Online type ID (numeric) — used to build the CCP icon CDN URL */
  typeId: number;
  /** Display name shown to the user */
  name: string;
  /** Called when the user clicks the link; receives the typeId */
  onClick?: (typeId: number) => void;
}

/** Base URL for CCP's official item icon CDN (no authentication required) */
const ICON_BASE = 'https://images.evetech.net/types';

/**
 * ItemLink — inline item name + 18px icon.
 *
 * Keyboard-accessible via the <button> element; the aria-label combines
 * the action ("Select") with the item name for screen-reader clarity.
 */
const ItemLink: FC<ItemLinkProps> = ({ typeId, name, onClick }) => {
  const iconUrl = `${ICON_BASE}/${typeId}/icon?size=32`;

  return (
    <button
      type="button"
      className="item-link"
      onClick={() => onClick?.(typeId)}
      aria-label={`Select ${name}`}
    >
      <img
        className="item-link-icon"
        src={iconUrl}
        alt=""            /* Decorative — the button label carries the meaning */
        width={18}
        height={18}
        onError={(e) => {
          /* Hide broken icon gracefully; CSS background-color acts as fallback */
          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
      />
      {name}
    </button>
  );
};

export default ItemLink;
