/**
 * FORGE v1.0 — Shared TypeScript interfaces
 *
 * Central type definitions for all data shapes flowing through the app.
 * Split into four sections:
 *   1. UI types   — consumed by React components
 *   2. ESI types  — raw responses from EVE Swagger Interface
 *   3. API types  — responses from the FORGE backend endpoints
 *   4. Auth types — authentication state machine
 */

// ══════════════════════════════════════════════════════════════════════════
// 1. UI TYPES
// ══════════════════════════════════════════════════════════════════════════

export type OwnedStatus = 'BPO' | 'BPC' | '—';

export interface Market {
  id: number;
  name: string;
  region: string;
  type: 'hisec' | 'nullsec';
}

export type RegionalPriceEntry = { sell: number; buy: number; median: number };
export type RegionalPrices = Record<number, RegionalPriceEntry>;

export interface MarketItem {
  rank: number;
  typeId: number;
  name: string;
  category: string;
  profitPerRun: number;
  margin: number;
  iskPerHour: number;
  buildTime: string;
  /** Numeric minutes — used for column sorting */
  buildTimeMinutes: number;
  owned: OwnedStatus;
  canBuild: boolean;
}

export interface Material {
  typeId: number;
  name: string;
  quantity: string;
}

export interface ItemDetail {
  typeId: number;
  name: string;
  category: string;
  owned: OwnedStatus;
  profitPerRun: number;
  margin: number;
  iskPerHour: number;
  buildTime: string;
  sellPrice: number;
  matCost: number;
  materials: Material[];
}

export type ChatRole = 'user' | 'assistant';

/**
 * A single message in the AI advisor conversation.
 * content may contain [[Name|typeId]] tokens parsed by ChatPanel.
 * id and timestamp are optional for backward compatibility.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  id?: string;
  timestamp?: Date;
}

export type TabId = 'market' | 'blueprints';
export type SortField = 'rank' | 'profitPerRun' | 'margin' | 'iskPerHour' | 'buildTimeMinutes';
export type SortDirection = 'asc' | 'desc';

export interface ActiveJob {
  name: string;
  quantity: number;
  remaining: string;
  done: boolean;
  /** ESI activity_id: 1=Mfg, 3=TE Research, 4=ME Research, 5=Copy, 8=Invention, 9=Reactions, 11=Rev.Eng */
  activityId?: number;
}

export interface CharacterInfo {
  characterId: number;
  name: string;
  walletISK: number;
  activeJobCount: number;
  blueprintCount: number;
  bpoCount: number;
  activeJobs: ActiveJob[];
}

/** Loading log entry for the LoadingScreen */
export interface DataLogItem {
  label: string;
  status: 'ok' | 'warn' | 'err';
  detail: string;
}

// ══════════════════════════════════════════════════════════════════════════
// 2. ESI TYPES (raw EVE Swagger Interface responses)
// ══════════════════════════════════════════════════════════════════════════

/** ESI blueprint entry from /characters/{id}/blueprints/ */
export interface EsiBlueprint {
  type_id: number;
  /** -1 means BPO (original); positive integer means BPC runs remaining */
  quantity: number;
  runs: number;
  material_efficiency: number;
  time_efficiency: number;
  location_id: number;
  location_flag: string;
  item_id: number;
  is_singleton: boolean;
}

/** ESI asset entry from /characters/{id}/assets/ */
export interface EsiAsset {
  type_id: number;
  quantity: number;
  location_id: number;
  location_flag: string;
  item_id: number;
  is_singleton: boolean;
}

/** ESI industry job from /characters/{id}/industry/jobs/ */
export interface EsiJob {
  job_id: number;
  product_type_id: number;
  blueprint_type_id: number;
  activity_id: number;
  runs: number;
  status: 'active' | 'delivered' | 'cancelled' | 'paused';
  end_date: string; // ISO 8601
  facility_id: number;
}

/** ESI character public info from /characters/{id}/ */
export interface EsiCharacter {
  name: string;
  corporation_id: number;
  security_status: number;
}

// ══════════════════════════════════════════════════════════════════════════
// 3. FORGE BACKEND API TYPES
// ══════════════════════════════════════════════════════════════════════════

/** One row from GET /api/top-profitable */
export interface TopProfitableItem {
  blueprint_id: number;
  product_id: number;
  product_name: string;
  material_cost: number;
  sell_price: number;
  buy_price: number;
  profit: number;
  profit_margin: number;
  isk_per_hour: number;
  /** Build time in seconds */
  build_time: number;
  material_count: number;
  computed_at: string;
  avg_daily_volume: number | null;
  market_group_id: number | null;
  liquidity_risk: string | null;
}

export interface TopProfitableResponse {
  results: TopProfitableItem[];
  meta: {
    count: number;
    sort: string;
    minProfit: number;
    lastComputed: string | null;
    lastRunStatus: string;
    riskBreakdown: Record<string, number>;
    hasMore?: boolean;
    offset?: number;
  };
}

/** Response from POST /api/ai-chat */
export interface AiChatResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  code?: string;
}

/** Material row in /api/item-details response */
export interface ItemDetailMaterial {
  materialId: number;
  name: string;
  needed: number;
  have: number;
  shortage: number;
  unitCost?: number;
  totalCost?: number;
  shortfallCost?: number;
  /** True if a blueprint exists in the game DB for this material (chain drill-down available) */
  canManufacture?: boolean;
}

/** Full response from POST /api/item-details */
export interface ItemDetailApiResponse {
  name?: string;
  description?: string;
  iconUrl?: string;
  priceHistory?: Array<{
    date: string;
    average: number;
    highest: number;
    lowest: number;
    volume: number;
    orderCount: number;
  }>;
  currentPrice?: {
    sell: number;
    buy: number;
    median: number;
  };
  buildInfo?: {
    blueprintOwned: boolean;
    canBuild: boolean;
    materials: ItemDetailMaterial[];
    totalCost: number;
    profit: number;
    profitMargin: number;
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 4. AUTH TYPES
// ══════════════════════════════════════════════════════════════════════════

export type AuthStatus = 'idle' | 'exchanging' | 'loading' | 'authed' | 'error';

// ══════════════════════════════════════════════════════════════════════════
// 5. v1.2.0 — TRUE PROFIT TYPES
// ══════════════════════════════════════════════════════════════════════════

/** System autocomplete result from GET /api/system-search */
export interface SystemSearchResult {
  system_id:   number;
  system_name: string;
}

/** Character manufacturing setup — stored in character_industry_settings */
export interface IndustrySettings {
  system_id:         number | null;
  system_name:       string | null;
  structure_type_id: number | null;
  /** JSON-encoded array of rig type_ids */
  rig_ids:           string;
  /** Stored as percentage 0–100 */
  facility_tax:      number;
}

/** Full response from POST /api/true-cost */
export interface TrueCostResponse {
  product_id:          number;
  runs:                number;
  sell_price:          number;

  total_material_cost: number;

  mfg_fees: {
    total:                number;
    system_cost_index:    number;
    system_cost_bonuses:  number;
    facility_tax:         number;
    scc_surcharge:        number;
    alpha_clone_tax:      number;
    estimated_item_value: number;
  };

  sales_tax: {
    total:                  number;
    broker_fee:             number;
    broker_fee_rate:        number;
    broker_relations_level: number;
    faction_standing:       number;
    corp_standing:          number;
    transaction_tax:        number;
    transaction_tax_rate:   number;
    accounting_level:       number;
  };

  true_profit:  number;
  true_margin:  number;
  region_id:    number;
  prices_warm:  boolean;   // false = precompute still loading; sell/profit are 0
  setup_configured: boolean;

  manufacturing_setup: {
    system_id:         number | null;
    system_name:       string;
    structure_type_id: number | null;
    structure_label:   string;
    rig_ids:           number[];
    facility_tax_pct:  number;
    sci_raw:           number;   // raw system cost index (0–1) for display
  };
}
