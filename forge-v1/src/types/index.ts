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
  /** 'jita' | 'history_30d' | 'no_data' | region string — price source for sell price */
  priceSource?: string | null;
  /** 30-day average price when sell orders are absent (display reference only) */
  avg30dPrice?: number | null;
  /** v1.20 — mean daily units traded on the market (from ESI 30-day history). Liquidity signal. */
  avgDailyVolume?: number | null;
  /** v1.20 — liquidity classification from the precompute: 'low_volume' | 'contract_only' | 'extreme_margin' | 'no_buy_orders' | 'suspicious_spread' | null (liquid) */
  liquidityRisk?: string | null;
  /** v1.7 — haul cost for 1 finished unit (goods-out leg) */
  haulCostPerUnit?: number;
  /** v1.7 — effective ISK/m³ for the goods-out leg */
  haulIskPerM3?: number;
  /** v1.7 — packaged volume of the product in m³ */
  haulVolumeM3?: number;
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
export type SortField = 'rank' | 'profitPerRun' | 'margin' | 'iskPerHour' | 'buildTimeMinutes' | 'avgDailyVolume';
export type SortDirection = 'asc' | 'desc';

export interface ActiveJob {
  name: string;
  typeId: number;       // product type_id — used to open the detail panel on click
  quantity: number;
  remaining: string;
  done: boolean;
  /** ESI activity_id: 1=Mfg, 3=TE Research, 4=ME Research, 5=Copy, 8=Invention, 9=Reactions, 11=Rev.Eng */
  activityId?: number;
  /** Raw ISO end_date from ESI — used by TickerBar for live countdown */
  endDate?: string;
}

/** v1.32.0 — Jump clone with its installed implants (from ESI /characters/{id}/clones/) */
export interface JumpClone {
  jumpCloneId: number;
  locationId:  number;
  locationType: string;
  implants:    number[];
}

// ── Ticker pin system ─────────────────────────────────────────────────────────

export interface TickerGroup {
  id: string;
  name: string;
  color: string; // hex accent for the group label
}

export type TickerPinType =
  | 'price_sell'       // item sell price at hub
  | 'price_buy'        // item buy price at hub
  | 'price_spread'     // sell/buy spread % at hub
  | 'mfg_profit'       // manufacturing profit/run at hub
  | 'mfg_margin'       // manufacturing margin % at hub
  | 'mfg_isk_hour'     // manufacturing ISK/hr at hub
  | 'mfg_top_hub'      // top manufacturing opportunity at hub (no item needed)
  | 'trade_spread'     // station trading spread for item at hub
  | 'trade_top_hub'    // top station trading opportunity at hub (no item needed)
  | 'wallet'           // character wallet total
  | 'jobs_count'       // active job count
  | 'jobs_next'        // next completing job + countdown
  | 'jobs_free_slots'  // free manufacturing slots
  | 'pi_extractor'     // PI ECU expiry countdown (snapshot — re-pin to update)
  | 'pi_colony_isk';   // PI colony estimated ISK/day (snapshot)

export interface TickerPin {
  id: string;
  type: TickerPinType;
  label: string;          // user-visible name
  groupId: string;        // which layout group this pin belongs to
  regionId?: number;      // for hub-specific pins
  hubName?: string;       // cached hub display name
  typeId?: number;        // for item-specific pins
  itemName?: string;      // cached item name
  baseline?: number;      // value at pin time (for direction arrows)
  baselineDate?: number;  // unix ms when baseline was set (refresh daily)
  expiryTime?: string;    // ISO date — for pi_extractor countdown
  snapshotValue?: number; // stored value at pin time — for pi_colony_isk etc.
  addedAt: number;
  order: number;
}

export interface NewPinConfig {
  type: TickerPinType;
  label?: string;          // auto-generated if omitted
  groupId?: string;        // defaults to active group if omitted
  regionId?: number;
  hubName?: string;
  typeId?: number;
  itemName?: string;
  expiryTime?: string;     // pi_extractor
  snapshotValue?: number;  // pi_colony_isk
}

export type TickerColorClass = 'green' | 'red' | 'amber' | 'cyan' | 'neutral';
export type TickerAnimClass  = 'pulse-slow' | 'flash-fast' | 'glow-once' | 'none';

export interface TickerSlotData {
  pinId: string;
  primaryText: string;
  secondaryText?: string;
  direction: 'up' | 'down' | 'stable' | null;
  changePct: number | null;
  colorClass: TickerColorClass;
  animClass: TickerAnimClass;
  flashKey: number;   // increment on value change to restart one-shot CSS animation
  loading: boolean;
}

export interface TickerBroadcastPayload {
  pins: TickerPin[];
  slots: Record<string, TickerSlotData>;
}

/** Raw LP point balance for one NPC corp, as returned by ESI */
export interface LPPoint {
  corp_id:      number;
  corp_name:    string;
  faction_id:   number | null;
  faction_name: string | null;
  lp:           number;
}

export interface CharacterInfo {
  characterId: number;
  name: string;
  walletISK: number;
  activeJobCount: number;
  blueprintCount: number;
  bpoCount: number;
  activeJobs: ActiveJob[];
  lpPoints: LPPoint[];
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
  /** 'jita' | 'history_30d' | 'no_data' | 'region_XXXXXXX' — indicates which price source was used */
  price_source?: string | null;
  /** 30-day average trade price from ESI history (0 if unavailable) */
  avg_30d_price?: number | null;
  /** v1.7 — haul cost per unit of finished product (goods-out leg) */
  haul_cost_per_unit?: number;
  haul_isk_per_m3?: number;
  haul_volume_m3?: number;
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
  /** PI tier if this is a planetary commodity: 1=P1 2=P2 3=P3 4=P4. Null/absent if not PI. */
  piTier?: number | null;
}

/** Decryptor stats for the invention UI */
export interface InventionDecryptorStats {
  probMult: number;  // probability multiplier %  (e.g. 80 = +80%)
  runs:     number;  // run modifier added to output BPC
  me:       number;  // ME modifier on output BPC
  te:       number;  // TE modifier on output BPC
  output_runs?: number; // base_runs + runs (populated by server)
}

/** Client-side decryptor definitions (mirrors server DECRYPTORS constant) */
export const INVENTION_DECRYPTORS: Array<{ type: string; name: string } & InventionDecryptorStats> = [
  { type: 'none',                   name: 'No Decryptor',            probMult:   0, runs: 0, me:  0, te:  0 },
  { type: 'optimized_attainment',   name: 'Optimised Attainment',    probMult:  90, runs: 2, me:  1, te: -2 },
  { type: 'attainment',             name: 'Attainment',              probMult:  80, runs: 4, me: -1, te:  4 },
  { type: 'parity',                 name: 'Parity',                  probMult:  50, runs: 3, me:  1, te: -2 },
  { type: 'accelerant',             name: 'Accelerant',              probMult:  20, runs: 1, me:  2, te: 10 },
  { type: 'process',                name: 'Process',                 probMult:  10, runs: 0, me:  3, te:  6 },
  { type: 'symmetry',               name: 'Symmetry',                probMult:   0, runs: 2, me:  1, te:  8 },
  { type: 'optimized_augmentation', name: 'Optimised Augmentation',  probMult: -10, runs: 7, me:  2, te:  0 },
  { type: 'augmentation',           name: 'Augmentation',            probMult: -40, runs: 9, me: -2, te:  2 },
];

/** One datacore (or other consumed material) used per invention attempt */
export interface InventionDatacore {
  materialId:      number;
  name:            string;
  quantity:        number;
  unitPrice:       number;
  totalPerAttempt: number;
}

/** Invention origin info for a T2 item (which T1 blueprint it comes from) */
export interface InventionInfo {
  t1BlueprintId:   number;
  t1BlueprintName: string | null;
  baseProbability: number;
  expectedAttempts: number;
  outputRuns:      number;
  /** Expected ISK cost per T2 BPC produced (datacores only, no auth skills applied) */
  perBpcCost:      number;
  datacores:       InventionDatacore[];
}

/** One T2 outcome inventable from a T1 blueprint */
export interface InventionOption {
  t2BlueprintId:    number;
  t2ProductId:      number;
  t2Name:           string;
  t2SellPrice:      number;
  baseProbability:  number;
  expectedAttempts: number;
  outputRuns:       number;
  /** Expected datacores-only cost per T2 BPC at base probability */
  perBpcCost:       number;
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
    volume?: number;
    orderCount: number;
  }>;
  /** 'keepstar' when history comes from structure_market_history; absent for Jita ESI */
  priceHistorySource?: string;
  currentPrice?: {
    sell: number;
    buy: number;
    median: number;
    /** 30-day average trade price from ESI history — non-zero when no live sell orders */
    avg30d?: number;
  };
  buildInfo?: {
    blueprintOwned: boolean;
    canBuild: boolean;
    materials: ItemDetailMaterial[];
    totalCost: number;
    profit: number;
    profitMargin: number;
    /** 'live' | 'history_30d' | 'no_data' — indicates whether sell price came from live orders or historical average */
    sellPriceSource?: string;
  };
  /** v1.12.0 — pricing derived from public single-item exchange contracts in-region. */
  contractPricing?: ContractPricing;
  /** v1.35.0 — for T2 items: origin T1 blueprint + invention materials */
  inventionInfo?: InventionInfo;
  /** v1.35.0 — for T1 items: all T2 products inventable from this blueprint */
  inventionOptions?: InventionOption[];
  /** v1.35.0 — shared datacores for all T1→T2 options (parallel to inventionOptions) */
  inventionDatacores?: InventionDatacore[];
}

/** Contract-derived price range for an item (POST /api/item-details, v1.12.0). */
export interface ContractPricing {
  regionId:    number;
  regionName:  string;
  /** Lowest qualifying single-item contract unit price. */
  low:         number;
  /** Highest. */
  high:        number;
  median:      number;
  /** Suggested sell price (median, nudged toward low end on wide spreads). */
  suggested:   number;
  /** Number of qualifying contracts behind these figures. */
  sampleCount: number;
  /** 'single' (v1) — single-item contracts. */
  source:      string;
  /** ISO timestamp of the ingest that produced this. */
  computedAt:  string;
  /** Human, data-derived explanation of the suggested price. */
  rationale:   string;
}

/** One sub-material in a chain breakdown (POST /api/material-breakdown). */
export interface BreakdownMaterial {
  materialId: number;
  name: string;
  /** Raw quantity per blueprint run (ME 0 — sub-levels are not ME-reduced in v1). */
  quantity: number;
  /** Buy-from-market unit price (sell-sourced, matching True Profit). */
  unitCost: number;
  buyPricePerUnit: number;
  /** Cheapest per-unit build cost (recursive). Null when not producible. */
  mfgCostPerUnit: number | null;
  /** True if a blueprint/reaction produces this sub-material (further expandable). */
  canManufacture: boolean;
  /** Activity of the sub-material's own blueprint: 1=manufacturing, 9=reaction. Null if not producible. */
  activityId: number | null;
  /** True if the user personally owns a blueprint for this sub-material. */
  blueprintOwned: boolean;
  /** PI tier 1–4, or null. */
  piTier: number | null;
  /** Cheaper sourcing for this node given current prices. */
  recommendation: 'build' | 'buy';
}

/** Full response from POST /api/material-breakdown (one chain level). */
export interface MaterialBreakdownResponse {
  typeId: number;
  manufacturable: boolean;
  /** Activity of the blueprint producing this node: 1=manufacturing, 9=reaction. */
  activityId?: number;
  productQuantity?: number;
  buildTime?: number;
  materials: BreakdownMaterial[];
}

/** One row returned by GET /api/inter-hub-arb */
export interface InterHubArbRow {
  product_id:        number;
  product_name:      string;
  buy_region_id:     number;
  sell_region_id:    number;
  buy_hub_name:      string;
  sell_hub_name:     string;
  buy_at:            number;   // lowest sell order at source hub
  sell_into:         number;   // highest buy order at dest hub
  gross_spread:      number;   // sell_into - buy_at
  gross_margin_pct:  number;
  net_profit:        number;   // after 3.6% sales tax
  net_margin_pct:    number;
  volume_m3:         number;   // packaged volume per unit
  isk_per_m3:        number | null;
  avg_daily_volume:  number | null;
  est_daily_profit:  number | null;
  // Live order-book depth (null when hub book not yet loaded)
  sell_orders_at_buy: number | null;
  sell_vol_at_buy:    number | null;
  buy_orders_at_sell: number | null;
  buy_vol_at_sell:    number | null;
}

/** Haul cost result from GET /api/inter-hub-haul */
export interface InterHubHaulResult {
  haul_enabled:         boolean;
  method:               string;
  method_label:         string;
  service_label:        string | null;
  haul_cost:            number;   // total ISK per unit
  effective_isk_per_m3: number;
  contracts:            number;
  jumps:                number;
  volume_m3:            number;
  /** Character's actual transaction tax rate (Accounting skill) */
  transaction_tax_rate: number;
  /** Character's actual broker fee rate (Broker Relations + standings at sell hub) */
  broker_fee_rate:      number;
  accounting_level:     number;
  broker_relations:     number;
}

/** Response from GET /api/inter-hub-arb */
export interface InterHubArbResponse {
  results:     InterHubArbRow[];
  buy_hub:     string;
  sell_hub:    string;
  count:       number;
  offset:      number;
  has_more:    boolean;
  min_margin:  number;
  sort_by:     string;
}

/** One ranked blueprint in the ME Research ROI table (POST /api/me-research-roi). */
export interface ResearchRoiItem {
  blueprintTypeId: number;
  productId:       number;
  productName:     string;
  /** Current researched ME of the owned BPO. */
  currentME:       number;
  /** Target ME used for the saving calc (default 10). */
  targetME:        number;
  /** Material cost for one run at current ME (sell-sourced). */
  matCostNow:      number;
  /** Material cost for one run at target ME. */
  matCostTarget:   number;
  /** ISK saved per run by researching current → target ME. */
  savingPerRun:    number;
  /** Saving as a % of current material cost. */
  pctSaving:       number;
  productQuantity: number;
  /** Estimated seconds to research current → target ME. Null until SDE research_time imported. */
  researchTimeSec: number | null;
}

/** Full response from POST /api/me-research-roi. */
export interface ResearchRoiResponse {
  items: ResearchRoiItem[];
  /** True when at least one blueprint had research_time (SDE imported). */
  research_time_available: boolean;
  target_me?: number;
  region_id?: number;
}

// ══════════════════════════════════════════════════════════════════════════
// 4. AUTH TYPES
// ══════════════════════════════════════════════════════════════════════════

export type AuthStatus = 'idle' | 'exchanging' | 'loading' | 'authed' | 'error';

/**
 * v1.5 — An additional EVE character loaded alongside the primary.
 * Data is loaded from ESI just like the primary character and stored
 * in sessionStorage under forge_alt_tokens.
 */
export interface AltCharacter {
  characterId:       number;
  name:              string;
  token:             string;
  blueprints:        EsiBlueprint[];
  assets:            EsiAsset[];
  skills:            Array<{ skill_id: number; active_skill_level: number }>;
  activeJobs:        ActiveJob[];
  walletISK:         number;
  blueprintCount:    number;
  bpoCount:          number;
  activeJobCount:    number;
  hasStandingsScope: boolean;
  /** True while this alt's ESI data is being fetched */
  loading:           boolean;
  error:             string | null;
}

/** Minimal per-character identity needed for PI fetching */
export interface PiCharacter {
  characterId: number;
  name:        string;
  token:       string;
}

/** Per-character slot summary passed to the Queue Planner */
export interface QueueCharacter {
  characterId: number;
  name:        string;
  token:       string;
  totalSlots:  number;
  freeSlots:   number;
  activeJobs:  ActiveJob[];
  /** skill_id → trained level, used for per-character blueprint skill checks */
  skills:      Record<number, number>;
}

// ══════════════════════════════════════════════════════════════════════════
// 5. v1.2.0 — TRUE PROFIT TYPES
// ══════════════════════════════════════════════════════════════════════════

/** System autocomplete result from GET /api/system-search */
export interface SystemSearchResult {
  system_id:   number;
  system_name: string;
}

export type HaulMethod = 'user_defined' | 'red_frog' | 'black_frog' | 'pushx' | 'self_haul';

/** Character manufacturing setup — stored in character_industry_settings */
export interface IndustrySettings {
  system_id:            number | null;
  system_name:          string | null;
  structure_type_id:    number | null;
  /** JSON-encoded array of rig type_ids */
  rig_ids:              string;
  /** Stored as percentage 0–100 */
  facility_tax:         number;
  /** Region ID of the hub where materials are sourced (default 10000002 = Jita) */
  material_region_id?:   number;
  material_region_name?: string | null;
  /** v1.6 — Haulage (Phase 1 compat) */
  haul_enabled:          boolean;
  leg1_haul_rate:        number;   // ISK/m³ (user_defined)
  leg2_haul_rate:        number;
  /** v1.7 — Phase 2 method + per-method params */
  leg1_method?:          HaulMethod;
  leg2_method?:          HaulMethod;
  leg1_collateral?:      number;
  leg2_collateral?:      number;
  leg1_isk_per_jump?:    number;
  leg2_isk_per_jump?:    number;
  leg1_flat_total?:      number;
  leg2_flat_total?:      number;
  leg1_service_label?:   string | null;
  leg2_service_label?:   string | null;
  leg1_self_char_id?:    number | null;
  leg1_self_ship?:       string | null;
  leg1_self_fuel?:       number;
  leg2_self_char_id?:    number | null;
  leg2_self_ship?:       string | null;
  leg2_self_fuel?:       number;
  /** v1.35.0 — invention-specific settings (separate structure may differ from mfg) */
  invention_rig_ids?:    string;
  invention_system_id?:  number | null;
  invention_system_name?: string | null;
  /** v1.35.0 — inter-hub independent haul config */
  interhub_haul_enabled?:  boolean;
  interhub_method?:        string;
  interhub_haul_rate?:     number;
  interhub_isk_per_jump?:  number;
  interhub_flat_total?:    number;
  interhub_self_fuel?:     number;
  interhub_collateral?:    number;
  interhub_service_label?: string | null;
  interhub_self_char_id?:  number | null;
  interhub_self_ship?:     string | null;
}

// ══════════════════════════════════════════════════════════════════════════
// 6. v1.5.1 — FEE RATES (used to align Market Opportunities with True Profit)
// ══════════════════════════════════════════════════════════════════════════

/** Response from GET /api/character-fee-rates */
export interface FeeRates {
  /** Broker fee as a decimal fraction (e.g. 0.025 = 2.5%) */
  broker_fee_rate:      number;
  /** Transaction tax as a decimal fraction (e.g. 0.0375 = 3.75%) */
  transaction_tax_rate: number;
  /** System Cost Index for the character's configured manufacturing system */
  sci:                  number;
  /** SCC surcharge — always 0.02 */
  scc_rate:             number;
  /** Facility tax as a decimal fraction */
  facility_tax:         number;
  /** True if the character has configured a manufacturing system */
  setup_configured:     boolean;
}

// ══════════════════════════════════════════════════════════════════════════
// 7. v1.4.0 — CORP TYPES
// ══════════════════════════════════════════════════════════════════════════

/** Response from GET /api/corp/status */
export interface CorpStatus {
  configured:          boolean;
  corp_id?:            number;
  corp_name?:          string;
  director_char_name?: string;
  last_refresh_at?:    string | null;
  last_refresh_status?: string | null;
}

/** Response from GET /api/corp/access-status */
export interface CorpAccessStatus {
  hasAccess: boolean;
  method?:   'admin' | 'director' | 'ceo';
}

/** One corp blueprint row from GET /api/corp/blueprints */
export interface CorpBlueprint {
  item_id:             number;
  type_id:             number;
  product_id:          number | null;
  name:                string;
  bp_type:             'BPO' | 'BPC';
  quantity:            number;
  runs:                number;
  me:                  number;
  te:                  number;
  location_id:         number | null;
  location_flag:       string | null;
  fetched_at:          string;
}

/** One corp asset row (aggregated by type_id) from GET /api/corp/assets */
export interface CorpAsset {
  type_id:         number;
  name:            string;
  total_quantity:  number;
  fetched_at:      string;
}

/** One corp industry job row from GET /api/corp/jobs */
export interface CorpJob {
  job_id:              number;
  installer_id:        number | null;
  installer_name:      string;
  blueprint_type_id:   number | null;
  blueprint_name:      string;
  product_type_id:     number | null;
  product_name:        string;
  activity_id:         number | null;
  runs:                number | null;
  status:              string | null;
  start_date:          string | null;
  end_date:            string | null;
  duration:            number | null;
  fetched_at:          string;
}

/** Response from GET /api/corp/blueprints */
export interface CorpBlueprintsResponse {
  blueprints: CorpBlueprint[];
  meta: { total: number; limit: number; offset: number; last_refresh_at: string | null };
}

/** Response from GET /api/corp/assets */
export interface CorpAssetsResponse {
  assets: CorpAsset[];
  meta: { total: number; limit: number; offset: number; last_refresh_at: string | null };
}

/** Response from GET /api/corp/jobs */
export interface CorpJobsResponse {
  jobs: CorpJob[];
  meta: { count: number; last_refresh_at: string | null };
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

  /** v1.35.0 — Invention overhead (Box 4b). Null for non-T2 products. */
  invention_cost?: {
    total:                 number;
    per_bpc_cost:          number;
    effective_probability: number;
    base_probability:      number;
    skill_factor:          number;  // 1 + enc/40 + sci1/30 + sci2/30
    skill_bonus:           number;  // = skill_factor - 1 (kept for backward compat)
    rig_bonus:             number;
    prob_bonus:            number;  // manual flat bonus (rigs / custom implants)
    expected_attempts:     number;
    datacores_cost:             number;
    job_cost:                   number;
    decryptor_cost:             number;  // amortized decryptor buy cost
    dc_cost_per_attempt:        number;
    decryptor_cost_per_attempt: number;
    job_cost_per_attempt:       number;
    decryptor_type:             string;
    decryptor:                  InventionDecryptorStats;
    output_runs:           number;  // base runs + decryptor run modifier
    datacores: InventionDatacore[];
    skills: Array<{ skillId: number; level: number }>;
  } | null;

  /** v1.6/v1.7 — Haulage (Box 5). Zero values when haul not configured. */
  haul_cost: {
    total:          number;
    leg1_cost:      number;
    leg2_cost:      number;
    leg1_volume_m3: number;
    leg2_volume_m3: number;
    /** Phase 1 compat — raw ISK/m³ for user_defined; 0 for provider methods */
    leg1_rate:      number;
    leg2_rate:      number;
    /** Phase 2 */
    leg1_method:               string;
    leg2_method:               string;
    leg1_jumps:                number;
    leg2_jumps:                number;
    leg1_isk_per_m3_effective: number;
    leg2_isk_per_m3_effective: number;
    leg1_contracts:            number;
    leg2_contracts:            number;
    leg1_collateral:           number;
    leg2_collateral:           number;
    leg1_service_label:        string | null;
    leg2_service_label:        string | null;
    leg1_self_ship:            string | null;
    leg2_self_ship:            string | null;
    provider_rates_as_of:      string | null;
  };

  true_profit:  number;
  true_margin:  number;
  region_id:    number;
  prices_warm:  boolean;
  /** True when the lowest sell order is >3× median — profit calculated using median instead. */
  sell_price_anomaly?: boolean;
  setup_configured: boolean;

  /** v1.17.0 — effective build time + ISK/hr (incl. TE, Industry skills, structure TE, implant) */
  time?: {
    base_build_seconds:      number;
    effective_build_seconds: number;
    isk_per_hour:            number;
    te_pct:                  number;
    industry_level:          number;
    advanced_industry_level: number;
    structure_te_bonus_pct:  number;
    mfg_implant:    { name: string; pct: number } | null;
    reproc_implant: { name: string; pct: number } | null;
  };

  manufacturing_setup: {
    system_id:         number | null;
    system_name:       string;
    structure_type_id: number | null;
    structure_label:   string;
    rig_ids:           number[];
    facility_tax_pct:  number;
    sci_raw:           number;
    /** v1.9.3 — Effective ME breakdown */
    is_t2?:              boolean;
    blueprint_me?:       number;  // T1: researched BPO ME; T2: t2_base_me + decryptor_me_bonus
    t2_base_me?:         number | null;
    decryptor_me_bonus?: number | null;
    structure_me_bonus?: number;
    rig_me_bonus?:       number;
    effective_me?:       number;
  };
}

/** v1.33.3 — one material's live sell-order check from /api/material-stock-check */
export interface MaterialStockCheckResult {
  materialId:   number;
  needed:       number;
  /** Cumulative sell-order volume available right now (all orders, not just the cheapest) */
  availableQty: number;
  orderCount:   number;
  /** Real walked-book cost to buy min(availableQty, needed) units */
  cost:         number;
  /** true when availableQty >= needed — this material's shortage can be fully filled right now */
  covered:      boolean;
}

export interface MaterialStockCheckResponse {
  /** 'ok' = fully fixable now; 'mixed' = one or more materials are thin; 'blocked' = stock is fine but cost > wallet */
  verdict:   'ok' | 'mixed' | 'blocked';
  totalCost: number;
  wallet:    number;
  materials: MaterialStockCheckResult[];
}

// ── 7. STATION TRADING TYPES (v1.27.0) ──────────────────────────────────────

export interface TradingDepthLevel {
  price: number;
  qty:   number;
}

export interface TradingScanItem {
  typeId:        number;
  name:          string;
  sell:          number;
  buy:           number;
  netProfit:     number;
  netMarginPct:  number;
  brokerFeeBuy:  number;
  brokerFeeSell: number;
  transTax:      number;
  sellOrders:    number;
  buyOrders:     number;
  sellQtyTop:    number;
  buyQtyTop:     number;
  avgDailyVol:   number;
  sampleDays:    number;
  iskPerDay:     number;
  sellDepth:     TradingDepthLevel[];
  buyDepth:      TradingDepthLevel[];
}

export interface TradeHub {
  id:    string;
  name:  string;
  label: string;
}

export interface TradingMeta {
  hubId:        string;
  station:      string;
  stationLabel: string;
  stationId:    number;
  regionId:     number;
  updatedAt:    number | null;
  ageSec:       number | null;
  expiresInSec: number | null;
  types:        number;
  warming:      boolean;
  lastError:    string | null;
}

export interface TradingScanResponse {
  results:            TradingScanItem[];
  total:              number;
  totalMatched:       number;   // before 500-result cap
  jitaBookSize:       number;
  coveredWithVolume:  number;
  hubVolumeEnriched?: boolean;
  brokerFeeRate:      number;
  transactionTaxRate: number;
  sessionCached?:     boolean;  // false = session not yet pushed, fees are defaults
  meta:               TradingMeta;
}

export interface TradingWatchlistEntry {
  typeId: number;
  name:   string;
}

export interface CharacterOrder {
  order_id:      number;
  type_id:       number;
  name:          string;
  price:         number;
  volume_remain: number;
  volume_total:  number;
  is_buy_order:  boolean;
  duration:      number;
  issued:        string;
  location_id:   number;
  range:         string;
  isUndercut:    boolean;
  undercutBy:    number;
  bookBest:      number | null;
}

export interface CharacterOrdersResponse {
  orders: CharacterOrder[];
  meta:   TradingMeta;
}

// ── LP Store (v1.36.0) ───────────────────────────────────────────────────────

export interface LPOfferRequiredItem {
  type_id:    number;
  name:       string;
  quantity:   number;
  unit_price: number;
  total_cost: number;
}

export interface LPOffer {
  offer_id:       number;
  corp_id:        number;
  corp_name:      string;
  faction_id:     number | null;
  faction_name:   string | null;
  type_id:        number;
  item_name:      string;
  quantity:       number;
  lp_cost:        number;
  isk_cost:       number;
  required_items: LPOfferRequiredItem[];
  jita_buy:       number;
  revenue:        number;
  req_cost:       number;
  net_isk:        number;
  isk_per_lp:     number;
  volume:         number | null;
  category_name:  string | null;
}

export interface LPFaction {
  faction_id:  number;
  faction_name: string;
  corp_count:  number;
}

export interface LPCorp {
  corp_id:     number;
  corp_name:   string;
  offer_count: number;
}

export interface LPStoreResponse {
  offers:               LPOffer[];
  total:                number;
  prices_live:          boolean;
  hub_name?:            string;
  transaction_tax_rate?: number;
  session_cached?:       boolean;
}

