# FORGE — Persistent Project Memory

> This file is the authoritative context document for Claude sessions working on this project.
> Read this first. Update it whenever significant decisions, changes, or discoveries are made.
> Last updated: v1.1 — multi-market support + cross-hub AI comparison

---

## 1. What FORGE Is

**F.O.R.G.E.** — Fabrication, Operations, Resource & Guidance Engine

An EVE Online manufacturing intelligence web application for the **UKC corporation**. It connects to the EVE ESI (EVE Swagger Interface) API via OAuth, loads a player's character data (blueprints, assets, skills, jobs, wallet), and provides:

- **Market Opportunities tab** — pre-computed profitability per selected trade hub, ranked by profit/margin/ISK-per-hour, filtered to only show items the character can actually build given their trained skills
- **Market hub selector** — single dropdown in Header; switching hub refetches precomputed data for that region
- **Blueprints tab** — full ESI blueprint library with BPO/BPC detection, T2 highlighting, search/filter
- **Assets tab** — inventory grouped by type with quantity sums
- **Jobs tab** — active industry jobs with time remaining
- **Right sidebar** — drill-down production chain for any item; prices shown for the currently selected hub
- **AI chat panel (F.O.R.G.E. AI)** — Anthropic Claude advisor with live character context, 9 tools, history persistence, cross-hub comparison capability

**Live domain:** https://forge-ukc.com  
**GitHub:** https://github.com/SacuShi/forge-manufacturing.git  
**Current version:** v1.1 (branch: `feature/v1.1-multimarket`, commit `75190fc`)  
**Version scheme:** `major.feature.change.patch`

---

## 2. Infrastructure & Deployment

### Server
| Property | Value |
|---|---|
| Host | 192.168.1.62 |
| User | gumpy54 |
| Process manager | PM2 (`pm2 restart forge`) |
| Server directory | `/home/gumpy54/forge-server/` |
| Frontend static files | `/home/gumpy54/forge-server/public/` |
| Database | `/home/gumpy54/forge-db/forge.db` (SQLite) |
| Proxy | Cloudflared tunnel → forge-ukc.com |

### Deploy commands (run from local machine)
```bash
# Backend
scp server/server.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/server.js
scp server/sde-import.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/sde-import.js

# Frontend (ALWAYS deploy index.html + assets/ together — Vite hashes filenames on every build)
scp forge-v1/dist/index.html gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/index.html
scp -r forge-v1/dist/assets gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/

# Restart
ssh gumpy54@192.168.1.62 "pm2 restart forge"

# SDE import (stop forge first — it locks the DB)
ssh gumpy54@192.168.1.62 "pm2 stop forge && cd ~/forge-server && node sde-import.js && pm2 start forge && sleep 5 && curl -s -X POST http://localhost:3000/api/trigger-precompute"
```

### CRITICAL deployment notes
- Vite hashes output filenames on every build (e.g. `index-DgGW3P7F.js`). Always upload `index.html` AND `assets/` together.
- After deploying server.js with multi-region schema changes, the first `pm2 restart` triggers DB migration (DROP + CREATE `precomputed_profits` if `region_id` column missing), then `runPreCompute` loops all 6 regions. Allow 2–5 min for precompute to complete — non-Jita hubs will be empty until then. Watch logs: `ssh gumpy54@192.168.1.62 "pm2 logs forge --lines 60"`

### Local paths
| Item | Path |
|---|---|
| Repo root | `C:\Users\AndyMcD\Desktop\forge-manufacturing` |
| Frontend source | `C:\Users\AndyMcD\Desktop\forge-manufacturing\forge-v1\src\` |
| Frontend dist | `C:\Users\AndyMcD\Desktop\forge-manufacturing\forge-v1\dist\` |
| Backend | `C:\Users\AndyMcD\Desktop\forge-manufacturing\server\` |

### Build
```bash
cd forge-v1
npm install          # first time only
npm run build        # tsc -b && vite build → dist/
```

---

## 3. Tech Stack

### Frontend
| Technology | Version | Role |
|---|---|---|
| React | 19.2.6 | UI framework |
| TypeScript | ~6.0.2 | Type safety |
| Vite | 8.0.12 | Build tool / dev server |
| CSS | Custom (no framework) | Styling via CSS variables |

### Backend
| Technology | Role |
|---|---|
| Node.js | Runtime |
| Express | HTTP server |
| SQLite (sqlite3) | Database |
| node-fetch | HTTP client (ESI calls) |
| helmet | Security headers |
| dotenv | Environment variables |
| Anthropic SDK | Claude AI integration |

### External Services
| Service | URL | Purpose |
|---|---|---|
| EVE ESI | https://esi.evetech.net | Character data (blueprints, assets, skills, jobs, wallet) + market prices |
| EVE SSO | https://login.eveonline.com | OAuth authentication |
| EVE Image Server | https://images.evetech.net | Item/character icons |
| everef.net | https://data.everef.net/reference-data/reference-data-latest.tar.xz | SDE reference data |
| Anthropic API | claude-sonnet-4-6 | AI advisor |

---

## 4. Repository Structure

```
forge-manufacturing/
├── server/
│   ├── server.js           ← Express backend (v1.1)
│   ├── sde-import.js       ← SDE import script (v2)
│   └── forge-security.js   ← Auth + rate limiting middleware
├── forge-v1/
│   ├── src/
│   │   ├── App.tsx             ← Root: auth states, market data, chat logic, market hub state
│   │   ├── main.tsx
│   │   ├── api/
│   │   │   └── client.ts       ← apiGet / apiPost helpers
│   │   ├── components/
│   │   │   ├── Header.tsx      ← Top bar; contains MarketSelector + AI toggle
│   │   │   ├── MarketSelector.tsx ← NEW v1.1: hub dropdown (6 trade hubs); MARKETS constant
│   │   │   ├── LeftSidebar.tsx ← Character card, nav tabs, quick prompts, jobs
│   │   │   ├── MainContent.tsx ← Tabs: Market, Blueprints, Assets, Jobs
│   │   │   ├── RightSidebar.tsx← Item detail panel, price chart (hub-aware since v1.1)
│   │   │   ├── ChatPanel.tsx   ← AI chat slide-in panel
│   │   │   ├── ItemTable.tsx   ← Sortable market opportunities table
│   │   │   ├── ItemLink.tsx    ← Clickable item token in chat messages
│   │   │   ├── LoginScreen.tsx ← EVE SSO login page
│   │   │   └── LoadingScreen.tsx← Step-by-step data load progress log
│   │   ├── hooks/
│   │   │   ├── useAuth.ts      ← Token exchange, ESI data loading, session state
│   │   │   ├── useItemDetail.ts← Item detail API calls (passes regionId since v1.1)
│   │   │   └── useItemNames.ts ← Item name lookups from DB
│   │   ├── styles/
│   │   │   ├── variables.css   ← CSS design tokens (dark/light mode)
│   │   │   ├── global.css      ← Reset, app shell, scrollbars
│   │   │   └── components.css  ← All component styles (market-selector styles added v1.1)
│   │   ├── types/
│   │   │   └── index.ts        ← All shared TypeScript interfaces (Market, RegionalPrices added v1.1)
│   │   ├── data/
│   │   │   └── mockData.ts     ← QUICK_PROMPTS constant + any static data
│   │   └── utils/
│   │       └── format.ts       ← formatBuildTime, ISK formatters
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig*.json
├── FORGE_MEMORY.md         ← THIS FILE
├── CHANGELOG.md
└── .gitignore
```

---

## 5. Database Schema

**DB file:** `forge.db` (SQLite)  
**DB path on server:** `/home/gumpy54/forge-db/forge.db`  
**In server.js:** `path.join(__dirname, '../forge-db/forge.db')`

### Tables

#### `items`
```sql
type_id    INTEGER PRIMARY KEY
name       TEXT
meta_level INTEGER DEFAULT 0   -- 0=T1, 1=T2, 2=T3
```

#### `blueprints`
```sql
blueprint_id      INTEGER PRIMARY KEY
product_id        INTEGER
product_quantity  INTEGER DEFAULT 1
build_time        INTEGER            -- seconds
activity_id       INTEGER DEFAULT 1  -- 1=manufacturing, 9=reaction
```

#### `blueprint_materials`
```sql
blueprint_id  INTEGER
material_id   INTEGER
quantity      INTEGER
PRIMARY KEY (blueprint_id, material_id)
```

#### `blueprint_skills`
```sql
blueprint_id  INTEGER NOT NULL
skill_id      INTEGER NOT NULL
skill_level   INTEGER NOT NULL
activity_id   INTEGER NOT NULL DEFAULT 1
PRIMARY KEY (blueprint_id, skill_id, activity_id)
```

#### `precomputed_profits` ← SCHEMA CHANGED IN v1.1
```sql
blueprint_id    INTEGER NOT NULL
region_id       INTEGER NOT NULL DEFAULT 10000002   -- ← NEW: part of composite PK
product_id      INTEGER NOT NULL
product_name    TEXT
material_cost   REAL DEFAULT 0    -- buy prices from THIS region
sell_price      REAL DEFAULT 0    -- sell orders from THIS region
buy_price       REAL DEFAULT 0
profit          REAL DEFAULT 0    -- sell_price × qty − material_cost (all same region)
profit_margin   REAL DEFAULT 0
isk_per_hour    REAL DEFAULT 0
build_time      INTEGER DEFAULT 0
material_count  INTEGER DEFAULT 0
computed_at     TEXT NOT NULL DEFAULT ''
price_source    TEXT DEFAULT 'jita'
avg_daily_volume REAL DEFAULT NULL  -- enriched from Jita ESI history, copied to all regions
market_group_id INTEGER DEFAULT NULL
liquidity_risk  TEXT DEFAULT NULL   -- NULL/""/low_volume/contract_only/extreme_margin/no_buy_orders/suspicious_spread
activity_id     INTEGER DEFAULT 1
PRIMARY KEY (blueprint_id, region_id)   -- ← composite PK, was just blueprint_id
```

**IMPORTANT — v1.1 migration:** If `region_id` column is absent on startup, `initDb` DROPS and recreates this table with the composite PK (data is ephemeral — safe to drop). The precompute then rebuilds all 6 regions.

**Volume enrichment:** `avg_daily_volume`, `market_group_id`, `liquidity_risk` are populated from **Jita ESI history only** (Jita rows), then copied to all other region rows via correlated UPDATE. This means all hubs share Jita-sourced volume data, which is acceptable since Jita volume is the most reliable indicator of item liquidity.

#### `precompute_runs`
```sql
id                   INTEGER PRIMARY KEY
completed_at         TEXT
blueprints_processed INTEGER
duration_seconds     REAL
status               TEXT
```

---

## 6. Market Hubs (v1.1)

```javascript
// server.js
const VALID_REGIONS = [
  10000002, // Jita       — The Forge     (hisec)
  10000043, // Amarr      — Domain        (hisec)
  10000032, // Dodixie    — Sinq Laison   (hisec)
  10000042, // Hek        — Metropolis    (hisec)
  10000030, // Rens       — Heimatar      (hisec)
  10000041, // Syndicate  — Syndicate     (nullsec)
];

const REGION_HUB_NAMES = {
  10000002: 'Jita', 10000043: 'Amarr', 10000032: 'Dodixie',
  10000042: 'Hek',  10000030: 'Rens',  10000041: 'Syndicate',
};
```

```typescript
// MarketSelector.tsx — MARKETS array mirrors VALID_REGIONS
export const MARKETS: Market[] = [
  { id: 10000002, name: 'Jita',      region: 'The Forge',   type: 'hisec'   },
  { id: 10000043, name: 'Amarr',     region: 'Domain',      type: 'hisec'   },
  { id: 10000032, name: 'Dodixie',   region: 'Sinq Laison', type: 'hisec'   },
  { id: 10000042, name: 'Hek',       region: 'Metropolis',  type: 'hisec'   },
  { id: 10000030, name: 'Rens',      region: 'Heimatar',    type: 'hisec'   },
  { id: 10000041, name: 'Syndicate', region: 'Syndicate',   type: 'nullsec' },
];
```

---

## 7. API Endpoints

All endpoints require `Authorization: Bearer <eve_token>` unless noted. Rate limited via `security.apiLimiter`.

### Authentication
| Method | Path | Notes |
|---|---|---|
| GET | `/api/eve-token` | EVE SSO OAuth callback — exchanges code for tokens |

### Market
| Method | Path | Params | Notes |
|---|---|---|---|
| GET | `/api/top-profitable-by-skills` | `limit`, `offset`, `sort`, `minProfit`, `minVolume`, `includeRisky`, **`regionId`** (v1.1) | Skill-filtered pre-computed profitability for chosen hub. Returns `{results, meta}` |
| GET | `/api/top-profitable` | same + `regionId` | Unfiltered version |
| GET | `/api/prices/:regionId` | — | Returns live ESI prices for a valid region, cached 1hr in `regionPriceCache` |

### Item Detail
| Method | Path | Notes |
|---|---|---|
| POST | `/api/item-details` | Body: `{typeId, characterId, regionId?}`. Returns name, icon, price history (Jita), current hub prices, build analysis with materials. `regionId` added v1.1 — defaults to 10000002 |
| POST | `/api/blueprint-metadata` | Body: `{blueprintTypeIds: number[]}`. Returns bulk `meta_level` map |

### Session Cache
| Method | Path | Notes |
|---|---|---|
| POST | `/api/session-data` | Caches character session for 2 hours |
| GET | `/api/session-data/:characterId` | Inspect cached session |
| POST | `/api/invalidate-session` | Clear session cache |

### Chat / AI
| Method | Path | Notes |
|---|---|---|
| POST | `/api/ai-chat` | Body: `{messages}`. Uses Anthropic Claude with prompt caching + 9 tools |
| GET | `/api/chat-history/:characterId` | Returns persisted chat messages |
| POST | `/api/save-message` | Persists one message |
| DELETE | `/api/chat-history/:characterId` | Clears history |

### Admin / Debug
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/ai-costs` | AI usage tracking |
| GET | `/api/diagnose-t2/:characterId` | T2 blueprint DB coverage |
| POST | `/api/trigger-precompute` | Manually trigger precompute (all 6 regions) |

### AI Tools (internal — used by `/api/ai-chat`) — v1.1
| Tool | Purpose |
|---|---|
| `get_precomputed(sort, limit, search, minProfit, includeRisky, activityType, regionId?)` | Pre-computed profitability. **`regionId` added v1.1** — defaults Jita. AI uses this for hub-specific top lists |
| `compare_markets(query)` | **NEW v1.1** — Self-join across all 6 hubs for a named item. Returns profit for (A) local materials+sell and (B) Jita materials+hub sell per hub, plus a `recommendation` block |
| `analyze_blueprints(sortBy, limit, buildableOnly)` | Player's blueprints vs assets |
| `get_blueprint(itemName/productId)` | Single blueprint materials + costs |
| `get_price(itemName)` | Live Jita price |
| `get_active_jobs(activityFilter?)` | Job queue |
| `get_t2_blueprints(sort?)` | All owned T2 blueprints |
| `diagnose_blueprints()` | DB coverage check |

---

## 8. Frontend Architecture

### Auth flow (`useAuth.ts`)
```
idle → (EVE SSO redirect) → exchanging → loading → authed
                                                  ↘ error
```

### State in `App.tsx` (v1.1)
| State | Type | Purpose |
|---|---|---|
| `theme` | `'dark'|'light'` | Persisted to localStorage |
| `chatOpen` | `boolean` | Chat panel visible |
| `chatAutoOpened` | `boolean` | Was chat auto-opened (closes on outside click) |
| `rawResults` | `TopProfitableResponse['results']` | Raw API results for all loaded pages |
| `marketItems` | `MarketItem[]` | **useMemo** derived from `rawResults + auth.blueprints` (no overlay) |
| `marketLoading` | `boolean` | Initial load OR market switch in progress |
| `marketHasMore` | `boolean` | Whether more pages exist |
| `marketLoadingMore` | `boolean` | "Load next 50" in-flight |
| `selectedMarket` | `Market` | **NEW v1.1** — currently selected hub (default Jita) |
| `selectedTypeId` | `number|null` | Currently selected item |
| `panelHistory` | `Array<{typeId,name}>` | Back-stack for chain drill-down |
| `chatMessages` | `ChatMessage[]` | Full conversation history |

### Market hub switching (`handleMarketChange`)
```typescript
// When user selects a different hub:
setSelectedMarket(market);
setRawResults([]);          // clear — new hub data incoming
setMarketLoading(true);
const data = await apiGet(`/api/top-profitable-by-skills?limit=50&regionId=${market.id}`, token);
setRawResults(data.results);
// MarketSelector is disabled while marketLoading=true
```
No client-side price overlay — all prices are fully precomputed per hub on the server.

### `marketItems` derivation
```typescript
const marketItems = useMemo<MarketItem[]>(() => {
  if (!rawResults.length) return [];
  return mapToMarketItems(rawResults, auth.blueprints);
}, [rawResults, auth.blueprints]);
```

### Load-more pagination
- Initial: `/api/top-profitable-by-skills?limit=50&regionId=${selectedMarket.id}`
- Load more: `?limit=50&offset=${rawResults.length}&regionId=${selectedMarket.id}`
- `mapToMarketItems(results, blueprints, rankOffset)` — rankOffset for correct rank numbering

### RightSidebar (hub-aware since v1.1)
- `selectedMarket` prop passed through from App
- Heading shows: `Current {marketLabel} Market` (e.g. "Current Amarr Market")
- Price history sparkline note: "history always Jita" when non-Jita selected
- `useItemDetail` passes `regionId` to POST `/api/item-details` — prices in detail panel match selected hub

---

## 9. Design System

### CSS Variables (variables.css)
Dark mode is default (`:root`). Light mode via `[data-theme='light']`.

| Variable | Dark Value | Purpose |
|---|---|---|
| `--color-bg-primary` | `#0a0e1a` | Page background |
| `--color-bg-secondary` | `#0f1420` | Panels, header |
| `--color-bg-tertiary` | `#151b2b` | Cards, inputs |
| `--color-accent-primary` | `#4fc3f7` | Cyan — primary accent |
| `--color-accent-hover` | `#7ae7ff` | Hover state |
| `--color-text-primary` | `#e0e6ed` | Main text |
| `--color-text-secondary` | `#b5bcc7` | Secondary text |
| `--color-text-tertiary` | `#8895a6` | Labels, meta |
| `--color-success` | `#4caf50` | Green |
| `--color-warning` | `#ff9800` | Orange |
| `--color-danger` | `#f44336` | Red |
| `--font-sans` | `'Courier New', monospace` | All text — intentional monospace |
| `--header-height` | `48px` | |
| `--sidebar-left-width` | `270px` | |
| `--sidebar-right-width` | `360px` | |
| `--chat-panel-width` | `510px` | |

### Key component classes
- `.btn` — standard ghost button
- `.btn-chat` — "Ask F.O.R.G.E. AI"; has `@keyframes forge-ai-pulse` 5s glow; `animation: none` when `.open`
- `.market-selector` — hub dropdown container (flex, gap 5px, white-space nowrap)
- `.market-dropdown` — the `<select>` element; styled to match UI; disabled during market load
- `.market-selector-loading` — `…` spinner text shown while loading
- `.pill-filter` — rounded filter chip
- `.mat-row-clickable` — hover highlight on material rows
- `.chat-panel` — slide-in AI panel

---

## 10. EVE Online Domain Knowledge

### Blueprint ownership detection
```typescript
const isBPO = bp.runs === -1;   // Original — infinite runs
const isBPC = bp.runs >= 0;     // Copy — limited runs
// WRONG: quantity === -1 is singleton flag, NOT BPO indicator
```

### activity_id values
| ID | Activity |
|---|---|
| 1 | Manufacturing |
| 3 | Time Efficiency Research |
| 4 | Material Efficiency Research |
| 5 | Copying |
| 8 | Invention |
| 9 | Reaction |
| 11 | Reverse Engineering |

### meta_group_id → meta_level
| meta_group_id | meta_level | Tier |
|---|---|---|
| (not 2 or 14) | 0 | T1 |
| 2 | 1 | T2 |
| 14 | 2 | T3 |

### Liquidity risk tiers
1. `contract_only` — item only on contracts, not open market
2. `extreme_margin` — buy/sell spread > 50%
3. `low_volume` — < 5 units/day average (WARNING level, not filtered by default)
4. `no_buy_orders` / `suspicious_spread`

### Multi-market strategy (v1.1 insight)
The most profitable EVE manufacturing strategy is almost always:
- **Buy materials in Jita** (deepest liquidity, tightest spreads)
- **Sell finished goods in a regional hub** where prices may be higher (e.g. Dodixie for Gallente hulls, Amarr for specific modules)

The `compare_markets` AI tool surfaces this automatically. Some items (e.g. Vexor in Dodixie) genuinely pay more locally than in Jita — always check rather than assuming Jita is best for selling.

---

## 11. SDE Import (sde-import.js v2)

Downloads `reference-data-latest.tar.xz` from `https://data.everef.net/reference-data/`.

| Step | Function | What it does |
|---|---|---|
| 1 | `addMetaLevel(typesData)` | Bulk UPDATE `items.meta_level` |
| 2 | `importBlueprintSkills(bpData)` | Creates + populates `blueprint_skills` |
| 3 | `importReactionFormulas(bpData)` | Imports reactions with `activity_id=9` |
| 4 | `ensureReactionItems(bpData, typesData)` | Inserts moon goo, gas, reaction components |
| 5 | `ensureAllBlueprintItems(typesData)` | Ensures all bp/product/material IDs in `items` |
| 6 | `importAllTypes(typesData)` | Bulk INSERT OR UPDATE all ~50k types |
| 7 | `verify()` | Reports counts; flags unnamed blueprints |

---

## 12. AI Advisor Architecture

### Model
`claude-sonnet-4-6` with Anthropic prompt caching (`cache_control: { type: "ephemeral" }`) on the static system prompt (`FORGE_STATIC_SYSTEM_PROMPT`).

### DO NOT MODIFY (preserved across all sessions)
- **EVE OAuth lines** (~700–900 in server.js) — authentication system
- **Prompt caching line** — `cache_control: { type: "ephemeral" }` on system prompt
- **`FORGE_STATIC_SYSTEM_PROMPT` constant** — may be extended/appended but core personality/scope/format rules must be preserved

### Tools (9 total as of v1.1)
See Section 7 AI Tools table above.

### `compare_markets` tool detail (v1.1)
```javascript
// SQL: self-join precomputed_profits to get both local and Jita material costs
SELECT sell.region_id, sell.sell_price, sell.material_cost AS local_material_cost,
       sell.profit AS local_profit, sell.profit_margin AS local_margin,
       jita.material_cost AS jita_material_cost,
       ROUND((sell.profit + sell.material_cost) / NULLIF(sell.sell_price, 0)) AS product_qty
FROM precomputed_profits sell
JOIN precomputed_profits jita ON jita.blueprint_id = sell.blueprint_id AND jita.region_id = 10000002
WHERE sell.product_name LIKE ?
ORDER BY sell.region_id
```
Returns per-hub: `localMaterials` (buy+sell same hub) and `jitaMaterials` (Jita inputs, hub sell) profit/margin/ISK-hr, plus a `recommendation` block with the single best strategy.

### Server-side context injection
AI receives character context from session cache (nothing sensitive from client):
wallet, blueprints, assets, active jobs, trained skills.

### Chat persistence
- Saved via `POST /api/save-message` after each turn
- Loaded on login via `GET /api/chat-history/:characterId`
- Capped at 20 messages restored; 10 messages sent per AI request

---

## 13. Development History & Key Decisions

### Origin → v0.9.x
- Express + SQLite backend, Jita price fetching, basic profitability calculation

### v0.9.2–v0.9.4
- Multi-market backend foundation; AI advisor; skills session caching; `/api/top-profitable-by-skills`

### v1.0.0.0 (major Claude session)
- Complete frontend rewrite: useAuth, LoadingScreen, Market/Blueprints/Assets/Jobs tabs
- BPO/BPC detection fix (`runs === -1` not `quantity === -1`)
- Right sidebar chain drill-down with `canManufacture`
- AI chat panel with history, quick prompts, server-side context
- Bulk SQL for materials (N queries → 2)
- SDE import v2 (everef.net)

### Post-v1.0.0.0 patches
| Commit | Change |
|---|---|
| `78c2888` | sde-import Step 6: bulk import all types.json — fixes faction/clothing/SKINR item names |
| `8729ad8` | AI button label; pulse glow animation; auto-open chat on login |
| `1713c9e` | Quick prompt chips: remove 40-char truncation |
| `7fb861a` | Load-more pagination: offset param; "Load next 50" button |

### v1.1 (this session — commit `75190fc`)

**Decision: single market dropdown, not dual**
User proposed two dropdowns (materials hub + sell hub). Decision was made to keep a single dropdown for simplicity, with the AI's `compare_markets` tool providing cross-hub strategy advice proactively. The AI will always surface the Jita-materials + regional-sell recommendation when relevant.

**Decision: full precompute per region, not client-side overlay**
Initial plan was a client-side price overlay (approximate qty from `profit+material_cost / sell_price`, overlay regional sell prices). This was replaced with running `runPreCompute` for all 6 regions — each hub gets fully self-consistent precomputed data. No approximations.

**Backend changes:**
- `VALID_REGIONS` array (6 hubs) + `REGION_HUB_NAMES` map added
- `GET /api/prices/:regionId` — cached ESI price endpoint
- `precomputed_profits` schema migrated: composite PK `(blueprint_id, region_id)`; migration in `initDb` via `pragma_table_info` check then DROP+CREATE
- `runPreCompute` refactored: loads blueprints/materials once, loops `VALID_REGIONS`, fetches prices per region, DELETE+INSERT with `region_id`
- `runVolumeEnrichment`: enriches Jita rows only, then copies volume data to all other regions via correlated UPDATE
- `/api/top-profitable` and `/api/top-profitable-by-skills`: both accept `?regionId`, WHERE starts with `region_id = ?`
- `/api/item-details`: accepts `regionId` in POST body
- AI `get_precomputed` hardcoded to `region_id = 10000002` → now accepts `regionId` param (defaults Jita)
- AI `get_precomputed` WHERE now uses parameterised `region_id = ?` (was hardcoded string)
- New `compare_markets` AI tool added
- `FORGE_STATIC_SYSTEM_PROMPT` updated: `get_precomputed` gets regionId docs; `compare_markets` documented with proactive-use instruction

**Frontend changes:**
- `Market`, `RegionalPrices` types added to `types/index.ts`
- New `MarketSelector.tsx` component + `MARKETS` constant
- `Header.tsx`: `selectedMarket`, `regionLoading`, `onMarketChange` props; `<MarketSelector>` replaces static teaser
- `App.tsx`: `selectedMarket` state; `handleMarketChange` clears rawResults and refetches for new hub; `handleLoadMoreMarket` includes `&regionId`; `marketItems` is `useMemo` (no overlay function); `marketLoading` passed as `regionLoading` to Header
- `useItemDetail.ts`: `regionId` param added, passed in POST body, added to useEffect deps
- `RightSidebar.tsx`: `selectedMarket` prop; heading shows hub name; sparkline note for non-Jita
- `components.css`: `.market-teaser` removed; `.market-selector`, `.market-dropdown`, `.market-selector-loading` added

---

## 14. Known Patterns & Conventions

### API calls
```typescript
apiGet<T>(path: string, token: string): Promise<T>
apiPost<T>(path: string, body: object, token: string): Promise<T>
```

### DB helpers (server.js)
```javascript
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
```

### Bulk SQL pattern (canManufacture)
```javascript
const ph = matIds.map(() => '?').join(',');
const manufSet = new Set(
  (await dbAll(`SELECT DISTINCT product_id FROM blueprints WHERE product_id IN (${ph})`, matIds))
  .map(r => r.product_id)
);
```

### Item icons
```
https://images.evetech.net/types/{typeId}/icon?size=32
https://images.evetech.net/characters/{characterId}/portrait?size=32
```

### React component conventions
- Functional components only (`FC<Props>`)
- `useCallback` for all handlers passed as props
- `useMemo` for derived/filtered lists
- `aria-label`, `role`, `aria-pressed` throughout

---

## 15. Environment Variables (.env on server)

```
PORT=3000
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
EVE_CALLBACK_URL=https://forge-ukc.com/api/eve-token
ANTHROPIC_API_KEY=...
JWT_SECRET=...
SESSION_SECRET=...
```

---

## 16. Security Model

- All AI/session/item endpoints require verified EVE token (`security.verifyEveToken`)
- Character ownership validation on history/session endpoints
- Rate limiting on all public endpoints via `security.apiLimiter`
- `VALID_REGIONS` whitelist — `/api/prices/:regionId` returns 400 for unknown region IDs
- Input sanitisation on AI tool queries (`replace(/[^a-zA-Z0-9 '\-]/g, '')`)
- Helmet CSP configured for EVE SSO + ESI domains
- Cloudflared proxy (`app.set('trust proxy', 1)`)
- Nothing sensitive sent from client — server injects from session cache

---

## 17. Outstanding / Future Work

- **Haul cost awareness** — factor in freight cost (ISK/m³ × volume × jumps) when AI compares hub strategies
- **Production planner UI** — visual queue builder from AI recommendations
- **Material shortfall shopping list** — "what do I need to buy and where" export from RightSidebar
- **Reaction chain drill-down** — chain icon exists but multi-step reaction chains not visualised
- **ME/TE optimisation suggestions** — AI has data but no dedicated UI tool
- **Push notifications** — jobs completing while user is away
- **SKINR items** — some dynamic IDs may still show "Item #..." if not in types.json

---

## 18. Quick Reference

### Rebuild & deploy (full)
```bash
# 1. Build
cd "C:\Users\AndyMcD\Desktop\forge-manufacturing\forge-v1" && npm run build

# 2. Deploy backend
scp server/server.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/server.js

# 3. Deploy frontend
scp forge-v1/dist/index.html gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/index.html
scp -r forge-v1/dist/assets gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/

# 4. Restart
ssh gumpy54@192.168.1.62 "pm2 restart forge"

# 5. Commit & push
cd "C:\Users\AndyMcD\Desktop\forge-manufacturing"
git add server/server.js forge-v1/src/... forge-v1/dist/...
git commit -m "feat: description"
git push origin feature/v1.1-multimarket
```

### Check server logs
```bash
ssh gumpy54@192.168.1.62 "pm2 logs forge --lines 50"
```

### Trigger precompute manually (all 6 regions)
```bash
ssh gumpy54@192.168.1.62 "curl -s -X POST http://localhost:3000/api/trigger-precompute"
```

### Health check
```
GET https://forge-ukc.com/api/health
```
