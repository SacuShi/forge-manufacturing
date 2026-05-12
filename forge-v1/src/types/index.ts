/**
 * FORGE v1.0 — Shared TypeScript interfaces
 *
 * Central type definitions for all data shapes flowing through the app.
 * These mirror the structures returned by /api/* endpoints in server.js
 * so that future live-data integration requires no type changes.
 */

// ── Ownership ──────────────────────────────────────────────────────────────

/** Blueprint ownership status for a given item */
export type OwnedStatus = 'BPO' | 'BPC' | '—';

// ── Market / Blueprint items ────────────────────────────────────────────────

/**
 * A single row in the profitability table.
 * Represents either a blueprint the character owns (My Blueprints tab)
 * or a market opportunity (Market Opportunities tab).
 */
export interface MarketItem {
  /** Sort position (1-based, default ordering) */
  rank: number;
  /** EVE Online type ID — used to fetch CCP item icons */
  typeId: number;
  /** Human-readable item name */
  name: string;
  /** Item category (e.g. "Heavy Assault Cruiser", "T2 Module") */
  category: string;
  /** Net profit per manufacturing run in ISK */
  profitPerRun: number;
  /** Profit margin as a percentage (can be negative) */
  margin: number;
  /** Estimated ISK earned per hour at this activity */
  iskPerHour: number;
  /** Human-readable build time (e.g. "3h 12m") */
  buildTime: string;
  /** Numeric build time in minutes — used for sorting */
  buildTimeMinutes: number;
  /** Whether the character owns the blueprint */
  owned: OwnedStatus;
  /** True if the character has sufficient materials to build now */
  canBuild: boolean;
}

// ── Materials ───────────────────────────────────────────────────────────────

/** A single material line in a blueprint's requirements */
export interface Material {
  /** EVE type ID of the material (e.g. 34 = Tritanium) */
  typeId: number;
  /** Human-readable material name */
  name: string;
  /** Pre-formatted quantity string (e.g. "2,812,450") */
  quantity: string;
}

// ── Item detail panel ───────────────────────────────────────────────────────

/**
 * Full detail data shown in the right sidebar when an item is selected.
 * Combines profitability metrics with build info and material requirements.
 */
export interface ItemDetail {
  typeId: number;
  name: string;
  category: string;
  owned: OwnedStatus;
  profitPerRun: number;
  margin: number;
  iskPerHour: number;
  buildTime: string;
  /** Jita sell price per unit in ISK */
  sellPrice: number;
  /** Total material cost per run in ISK */
  matCost: number;
  materials: Material[];
}

// ── Chat ────────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant';

/**
 * A single message in the AI advisor conversation.
 *
 * The `content` string may contain item-link tokens in the format:
 *   [[Item Name|typeId]]
 * which ChatPanel parses into clickable ItemLink components at render time.
 * This avoids dangerouslySetInnerHTML for user-facing text.
 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: Date;
}

// ── UI state ─────────────────────────────────────────────────────────────────

export type TabId = 'market' | 'blueprints';

export type SortField = 'rank' | 'profitPerRun' | 'margin' | 'iskPerHour' | 'buildTimeMinutes';

export type SortDirection = 'asc' | 'desc';

/** Active jobs running in manufacturing slots */
export interface ActiveJob {
  name: string;
  quantity: number;
  /** Remaining time display string, or 'Done' */
  remaining: string;
  done: boolean;
}

/** Character summary shown in the left sidebar */
export interface CharacterInfo {
  characterId: number;
  name: string;
  walletISK: number;
  activeJobCount: number;
  blueprintCount: number;
  bpoCount: number;
  activeJobs: ActiveJob[];
}
