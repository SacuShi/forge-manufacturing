# FORGE — Persistent Project Memory

> This file is the authoritative context document for Claude sessions working on this project.
> Read this first. Update it whenever significant decisions, changes, or discoveries are made.
> Last updated: v1.4.0 — Corp feature: PIN-gated corp blueprints / assets / jobs viewer, admin whitelist

---

## 1. What FORGE Is

**F.O.R.G.E.** — Fabrication, Operations, Resource & Guidance Engine

An EVE Online manufacturing intelligence web application for the **UKC corporation**. It connects to the EVE ESI (EVE Swagger Interface) API via OAuth, loads a player's character data (blueprints, assets, skills, jobs, wallet), and provides:

- **Market Opportunities tab** — pre-computed profitability per selected trade hub, ranked by profit/margin/ISK-per-hour, filtered to only show items the character can actually build given their trained skills
- **Market hub selector** — single dropdown in Header; switching hub refetches precomputed data for that region
- **Blueprints tab** — full ESI blueprint library with BPO/BPC detection, T2 highlighting, search/filter
- **Assets tab** — inventory grouped by type with quantity sums
- **Jobs tab** — active industry jobs with time remaining
- **Right sidebar** — drill-down production chain for any item; prices shown for the currently selected hub; **True Profit 4-box panel (v1.2.0)** showing material cost, mfg fees, sales tax, true profit
- **Industry Settings modal** — configure manufacturing system, structure type, rigs, facility tax for accurate True Profit (⚙ button in header)
- **AI chat panel (F.O.R.G.E. AI)** — Anthropic Claude advisor with live character context, 9 tools, history persistence, cross-hub comparison capability

**Live domain:** https://forge-ukc.com  
**GitHub:** https://github.com/SacuShi/forge-manufacturing.git  
**Current version:** v1.4.0 (branch: `main`)  
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
| everef.net (SDE) | https://data.everef.net/reference-data/reference-data-latest.tar.xz | SDE reference data |
| EVE ESI (industry) | https://esi.evetech.net/latest/industry/systems/ | **v1.2.0** — System Cost Index data. Fetched every 1hr, cached in `costIndexCache`. Also builds local solar-system name map (via `/universe/names/` bulk POST) for system autocomplete |
| EVE ESI (market prices) | https://esi.evetech.net/latest/markets/prices/ | **v1.2.0** — Adjusted prices for EIV calculation. Fetched every 6hr, cached in `adjustedPriceCache`. |
| Anthropic API | claude-sonnet-4-6 | AI advisor |

---

## 4. Repository Structure

```
forge-manufacturing/
├── server/
│   ├── server.js           ← Express backend (v1.2.0)
│   ├── sde-import.js       ← SDE import script (v2)
│   └── forge-security.js   ← Auth + rate limiting middleware
├── forge-v1/
│   ├── src/
│   │   ├── App.tsx             ← Root: auth states, market data, chat, industry settings
│   │   ├── main.tsx
│   │   ├── api/
│   │   │   └── client.ts       ← apiGet / apiPost helpers (dispatches session-expired event)
│   │   ├── components/
│   │   │   ├── Header.tsx      ← Top bar; MarketSelector + ⚙ settings cog + AI toggle
│   │   │   ├── MarketSelector.tsx ← Hub dropdown (6 trade hubs); MARKETS constant
│   │   │   ├── IndustrySettings.tsx ← NEW v1.2.0: modal for system/structure/rigs/tax
│   │   │   ├── LeftSidebar.tsx ← Character card, nav tabs, quick prompts, jobs
│   │   │   ├── MainContent.tsx ← Tabs: Market, Blueprints, Assets, Jobs
│   │   │   ├── RightSidebar.tsx← Item detail panel + True Profit 4-box (v1.2.0)
│   │   │   ├── ChatPanel.tsx   ← AI chat slide-in panel
│   │   │   ├── ItemTable.tsx   ← Sortable market opportunities table
│   │   │   ├── ItemLink.tsx    ← Clickable item token in chat messages
│   │   │   ├── LoginScreen.tsx ← EVE SSO login page (session-expired banner)
│   │   │   └── LoadingScreen.tsx← Step-by-step data load progress log
│   │   ├── hooks/
│   │   │   ├── useAuth.ts      ← Token exchange, ESI data; hasStandingsScope (v1.2.0)
│   │   │   ├── useItemDetail.ts← Item detail API calls (passes regionId)
│   │   │   ├── useTrueCost.ts  ← NEW v1.2.0: calls /api/true-cost for True Profit data
│   │   │   └── useItemNames.ts ← Item name lookups from DB
│   │   ├── styles/
│   │   │   ├── variables.css   ← CSS design tokens (dark/light mode)
│   │   │   ├── global.css      ← Reset, app shell, scrollbars
│   │   │   └── components.css  ← All component styles (True Profit + modal styles v1.2.0)
│   │   ├── types/
│   │   │   └── index.ts        ← Shared TS interfaces (IndustrySettings, TrueCostResponse v1.2.0)
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

#### `character_industry_settings` ← NEW v1.2.0
```sql
character_id           INTEGER PRIMARY KEY
system_id              INTEGER DEFAULT NULL       -- solar system where they build
system_name            TEXT    DEFAULT NULL
structure_type_id      INTEGER DEFAULT NULL       -- NULL=NPC, 35825=Raitaru, 35826=Azbel, 35827=Sotiyo
rig_ids                TEXT    DEFAULT '[]'       -- JSON array of rig type_ids (max 3)
facility_tax           REAL    DEFAULT 0.0        -- percentage 0–100 (converted to decimal for EVE Ref)
updated_at             TEXT    NOT NULL DEFAULT ''
```

#### `precompute_runs`
```sql
id                   INTEGER PRIMARY KEY
completed_at         TEXT
blueprints_processed INTEGER
duration_seconds     REAL
status               TEXT
```

#### `corp_config` ← NEW v1.4.0
```sql
corp_id              INTEGER PRIMARY KEY
corp_name            TEXT
director_char_id     INTEGER
director_char_name   TEXT
enc_refresh_token    TEXT NOT NULL  -- AES-256-GCM encrypted, base64
token_iv             TEXT NOT NULL  -- 12-byte IV, hex
token_tag            TEXT NOT NULL  -- 16-byte GCM auth tag, hex
pin_hash             TEXT NOT NULL  -- scrypt(pin, salt, N=16384), base64
pin_salt             TEXT NOT NULL  -- 32-byte salt, hex
last_refresh_at      TEXT
last_refresh_status  TEXT
created_at           TEXT
updated_at           TEXT
```

#### `corp_blueprints` ← NEW v1.4.0
```sql
item_id              INTEGER PRIMARY KEY  -- ESI unique item_id
corp_id              INTEGER
type_id              INTEGER
quantity             INTEGER  -- -1 = singleton
runs                 INTEGER  -- -1 = BPO, ≥0 = BPC
material_efficiency  INTEGER
time_efficiency      INTEGER
location_id          INTEGER
location_flag        TEXT
fetched_at           TEXT
```

#### `corp_assets` ← NEW v1.4.0
```sql
item_id       INTEGER PRIMARY KEY
corp_id       INTEGER
type_id       INTEGER
quantity      INTEGER
location_id   INTEGER
location_flag TEXT
is_singleton  INTEGER
fetched_at    TEXT
```

#### `corp_jobs` ← NEW v1.4.0
```sql
job_id              INTEGER PRIMARY KEY
corp_id             INTEGER
installer_id        INTEGER
blueprint_id        INTEGER
blueprint_type_id   INTEGER
product_type_id     INTEGER
activity_id         INTEGER
runs                INTEGER
status              TEXT
start_date          TEXT
end_date            TEXT
duration            INTEGER
output_location_id  INTEGER
fetched_at          TEXT
```

#### `corp_pin_sessions` ← NEW v1.4.0
```sql
character_id INTEGER PRIMARY KEY  -- character who verified PIN
corp_id      INTEGER
verified_at  TEXT
expires_at   TEXT                 -- 24hr expiry; checked on every data request
```

#### `corp_admin_access` ← NEW v1.4.0
```sql
character_id INTEGER PRIMARY KEY  -- bypasses PIN entirely
corp_id      INTEGER              -- NULL = all corps
note         TEXT                 -- admin note
added_at     TEXT
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

### Industry Settings (v1.2.0)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/industry-settings` | Fetch saved settings for authed character |
| POST | `/api/industry-settings` | Save settings (system_id, structure_type_id, rig_ids, facility_tax) |
| GET | `/api/system-search?q=<query>` | Autocomplete solar system names via **local name index** built from `costIndexCache.nameMap` (no ESI search call — deprecated). Returns up to 10 prefix-then-substring matches. |
| POST | `/api/true-cost` | Calculate True Profit. Body: `{product_id, me, te, runs, regionId}`. **No EVE Ref** — calculates locally: EIV from `blueprint_materials` + `adjustedPriceCache`, job cost from `costIndexCache` SCI, sales fees from session skills/standings. Returns 4-box breakdown. Returns `prices_warm: false` when region price cache is cold (never blocks on fetch). |

### Admin / Debug
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/ai-costs` | AI usage tracking |
| GET | `/api/diagnose-t2/:characterId` | T2 blueprint DB coverage |
| POST | `/api/trigger-precompute` | Manually trigger precompute (all 6 regions) |

### Corp (v1.4.0) — all require `Authorization: Bearer <eve_token>` except admin endpoints
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/corp/status` | None | Returns `{ configured, corp_id, corp_name, last_refresh_at }` |
| POST | `/api/corp/setup` | X-Admin-Key | Body: `{ code, redirect_uri, pin }`. Exchanges EVE OAuth code (must have corp scopes), encrypts refresh token, hashes PIN. Triggers initial ESI fetch. |
| POST | `/api/corp/verify-pin` | EVE token + auth rate limiter | Body: `{ pin }`. Creates 24hr session in `corp_pin_sessions`. |
| GET | `/api/corp/access-status` | EVE token | Returns `{ hasAccess, method: 'admin'|'pin', expires_at? }` |
| GET | `/api/corp/blueprints` | EVE token + PIN/admin | Query: `search`, `type` (BPO|BPC|all), `limit`, `offset`. Joins `items` for names. |
| GET | `/api/corp/assets` | EVE token + PIN/admin | Query: `search`, `limit`. Aggregated by type_id. |
| GET | `/api/corp/jobs` | EVE token + PIN/admin | Active corp industry jobs. |
| POST | `/api/corp/refresh` | EVE token + PIN/admin | Triggers background ESI data refresh (blueprints + assets + jobs). |
| GET | `/api/corp/admin/whitelist` | X-Admin-Key | List whitelisted characters. |
| POST | `/api/corp/admin/whitelist` | X-Admin-Key | Body: `{ character_id, note? }`. Add character to bypass-PIN whitelist. |
| DELETE | `/api/corp/admin/whitelist/:characterId` | X-Admin-Key | Remove from whitelist. |
| DELETE | `/api/corp/admin/config` | X-Admin-Key | Delete all corp config + cached data (for re-setup). |

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
| `get_price_comparison(item_name)` | **NEW v1.1.1** — Live buy/sell prices for **any item** across all 6 hubs. Returns `cheapest_to_buy_from`, `best_to_sell_into`, `arbitrage_opportunity`, full `all_hubs` list. Use for minerals, loot, commodities — anything not in the precomputed manufactured goods table |

---

## 8. Frontend Architecture

### Auth flow (`useAuth.ts`)
```
idle → (EVE SSO redirect) → exchanging → loading → authed
                                                  ↘ error
```

### State in `App.tsx` (v1.2.0)
| State | Type | Purpose |
|---|---|---|
| `theme` | `'dark'|'light'` | Persisted to localStorage |
| `chatOpen` | `boolean` | Chat panel visible |
| `chatAutoOpened` | `boolean` | Was chat auto-opened (closes on outside click) |
| `rawResults` | `TopProfitableResponse['results']` | Raw API results for all loaded pages |
| `marketItems` | `MarketItem[]` | **useMemo** derived from `rawResults + auth.blueprints` |
| `marketLoading` | `boolean` | Initial load OR market switch in progress |
| `marketHasMore` | `boolean` | Whether more pages exist |
| `marketLoadingMore` | `boolean` | "Load next 50" in-flight |
| `selectedMarket` | `Market` | Currently selected hub (default Jita) |
| `selectedTypeId` | `number|null` | Currently selected item |
| `panelHistory` | `Array<{typeId,name}>` | Back-stack for chain drill-down |
| `chatMessages` | `ChatMessage[]` | Full conversation history |
| `industrySettings` | `IndustrySettings|null` | **NEW v1.2.0** — loaded from `/api/industry-settings` on login |
| `settingsOpen` | `boolean` | **NEW v1.2.0** — IndustrySettings modal open |

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
// WRONG: quantity === -1 is singleton flag (asset location), NOT BPO indicator
// NOTE: blueprint type_id ≠ product type_id — always match by name:
//   productName + " Blueprint" → blueprint name lookup in itemNames Map
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

### EVE Manufacturing Fees (v1.2.0) — DO NOT get these wrong

**Broker fee (sell order placement):**
```
rate = max(1%, 3% − 0.3% × Broker_Relations − 0.03% × max(0, faction_standing) − 0.02% × max(0, corp_standing))
fee = sell_revenue × rate
```
- Minimum 1% regardless of skills/standings
- Connections and Diplomacy skills do NOT affect broker fee (only faction relations standing, unmodified)
- The NPC corp and faction for each hub are in `HUB_STANDINGS` server-side

**Transaction tax (trade completion):**
```
rate = max(0%, 7.5% × (1 − 11% × Accounting_level))
fee = sell_revenue × rate
```
- At Accounting 5: 7.5% × (1 − 0.55) = 3.375%

**Manufacturing job fee (calculated locally — no EVE Ref):**
```
EIV = Σ( adjustedPrice[material] × ceil(qty × (1 − ME/100)) × runs )
Job Cost = EIV × SCI + EIV × 0.02 (SCC) + EIV × facilityTax_decimal
```
- `adjustedPrices` from ESI `/markets/prices/` (6hr cache → `adjustedPriceCache`)
- `SCI` from ESI `/industry/systems/` (1hr cache → `costIndexCache.sciMap[systemId]`)
- `facility_tax` stored 0–100 in DB, converted to decimal (÷100) before calculation
- SCC Surcharge: **2%** of EIV (reduced from 4% in Legion update, July 2025)
- NPC station: use `structure_type_id = null`, user typically sets facility_tax = 0
- System Cost Index (SCI): typically 5–24% in high-sec hubs; varies by manufacturing activity
- ESI `/search/` endpoint is **deprecated** — system search uses local name index instead

**Structure bonuses (informational — EVE Ref handles actual calc):**
| Structure | type_id | ME bonus | TE bonus |
|---|---|---|---|
| Raitaru | 35825 | 1% | 15% |
| Azbel | 35826 | 1% | 20% |
| Sotiyo | 35827 | 1% | 25% |

**True Profit formula:**
```
true_profit = sell_price - broker_fee - transaction_tax - total_material_cost - total_job_cost
```

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

### v1.2.0 (latest commit `b1bf051`) — branch: `feature/v1.2.0-true-profit`

**True Profit feature — local ESI calculation, standings-aware fees, industry settings**

**Core concept:** Market Opportunities shows *estimated* profit (no fees). True Profit shows *real* profit after ALL costs: material cost + manufacturing job fee + sales tax (broker fee + transaction tax).

**Backend changes:**

- `character_industry_settings` table in `runMigrations()` — per-character manufacturing setup
- `HUB_STANDINGS` map: `regionId → { corp_id, faction_id }` — which NPC corp/faction standings affect broker fees at each hub
  - Jita: corp 1000035 (Caldari Navy), faction 500001 (Caldari State)
  - Amarr: corp 1000082, faction 500003 | Dodixie: corp 1000049, faction 500004
  - Hek/Rens: corp 1000070/1000006, faction 500002 (Minmatar)
  - Syndicate: corp 1000462, faction 500010
- `adjustedPriceCache` + `fetchAdjustedPrices()` — ESI `/markets/prices/` fetched every 6hr; returns `Map<type_id, adjusted_price>`
- `costIndexCache` + `fetchCostIndices()` — ESI `/industry/systems/` every 1hr; builds:
  - `sciMap`: `Map<system_id, sci_for_manufacturing>`
  - `nameMap`: `Map<name_lower, { system_id, system_name }>` — built via bulk `/universe/names/` POSTs in parallel batches of 1000 IDs (ESI `/search/` is deprecated)
- `/api/session-data` POST accepts `standings: { factions: {}, corps: {} }` and stores in session cache
- `GET /api/industry-settings` — fetch settings for authed character
- `POST /api/industry-settings` — save settings (upsert by character_id); `facility_tax` stored as pct (0–100)
- `GET /api/system-search?q=<>` — instant local prefix+substring matching against `costIndexCache.nameMap`; returns up to 10 results; warms cache on first call
- `POST /api/true-cost` — main endpoint, **never blocks on slow fetches** (returns `prices_warm: false` when cold):
  1. Reads session cache via `getCached('session:${characterId}')` for skills + standings
  2. Reads DB for industry settings (system, structure, rigs, facility_tax)
  3. Fetches `adjustedPrices` and `costIndices` (both cached — instant after warmup)
  4. Calculates EIV: `Σ(adjustedPrice[mat] × ceil(qty × meFactor) × runs)`
  5. Calculates job cost: `EIV × SCI + EIV × 0.02 (SCC) + EIV × (facilityTax/100)`
  6. Calculates broker fee: `max(1%, 3% − 0.3%×BR − 0.03%×max(0,faction) − 0.02%×max(0,corp))`
  7. Calculates transaction tax: `max(0%, 7.5% × (1 − 11%×Accounting))`
  8. Reads hub sell price from `regionPriceCache` (returns `prices_warm: false` if cold — **never** calls `fetchRegionPrices()` inline)
  9. Returns full breakdown: `{ total_material_cost, mfg_fees, sales_tax, true_profit, true_margin, prices_warm, manufacturing_setup }`

**Frontend changes:**

- `useAuth.ts`: `esi-characters.read_standings.v1` added to SCOPES; standings fetched in `loadCharacterData` (step 8, non-fatal — sets `hasStandingsScope`); standings included in `/api/session-data` POST; `hasStandingsScope: boolean` in AuthState and return value; `logout()` resets it
- `useTrueCost.ts` (new hook): accepts `(productTypeId, regionId, me, te, token)` directly — **no blueprint array**. ME/TE resolved in App.tsx via name-based matching (`productName + " Blueprint"`). Returns `{ data, loading, error }`
- `App.tsx`: `selectedBlueprintME/TE` useMemo resolves from `itemNames` map (name match, prefers BPO over BPC); passes to `useTrueCost`
- `IndustrySettings.tsx` (new component): modal with system autocomplete (300ms debounce, local-index-backed), structure type radio buttons, rigs accordion (max 3, grouped by category, greyed for NPC), facility tax %, Save button (disabled until system resolves). Button label: `⚙ Mfg Setup`
- `Header.tsx`: `onOpenSettings` prop added; ⚙ `settings-btn` (`⚙ Mfg Setup` text) next to MarketSelector
- `RightSidebar.tsx`: `trueCostData`, `trueCostLoading`, `trueCostError`, `onOpenSettings` props; 4-box panel below existing build info; `prices_warm: false` shows loading note; tooltip on Mfg Fees (EIV, raw SCI%, facility tax, SCC) and Sales Tax (broker rate, standings, transaction tax); BPO preference fix in `productToBlueprintMap` (`if (!ptbMap.has(pid) || isBpo)`)
- `App.tsx`: `industrySettings` + `settingsOpen` state; loads settings on login; `useTrueCost` hook; re-auth banner if `!auth.hasStandingsScope`; IndustrySettingsModal render
- `types/index.ts`: `SystemSearchResult`, `IndustrySettings`, `TrueCostResponse` (with `prices_warm`, `manufacturing_setup.sci_raw`) interfaces
- `components.css`: `.settings-btn`, `.reauth-banner`, `.cost-breakdown-row`, `.cost-box` family (4 colour variants), `.cost-tooltip` family, `.modal-overlay`/`.modal-panel` family, `.settings-*`, `.structure-*`, `.rig-*`, `.btn-primary`

**Re-auth banner:**
- Shows if `!auth.hasStandingsScope` (standings scope not granted on current token)
- Tells user to log out and back in to grant it
- Broker fee still calculates correctly (skills-only, no standings bonus) until re-auth

**Key bug fixes applied during development:**
- EVE Ref replaced: was giving 400 errors and 30s+ timeouts; replaced with local ESI calculation
- `fetchRegionPrices()` removed from `/api/true-cost` critical path (was causing Cloudflare 502 on cold cache)
- ESI `/search/` deprecated — system search now uses local `nameMap` built from `/universe/names/` bulk lookup
- BPO showing as BPC: fixed in both `productToBlueprintMap` (prefer BPO) and ME/TE resolution (moved to App.tsx, name-based match)
- Settings button invisible: changed from bare `⚙` glyph to `⚙ Mfg Setup` text button

### v1.1.1 (commit `05a99f9`) — deployed ✓

**Feature 1: `get_price_comparison` AI tool**
- `getItemPricesAllRegions(typeId)` helper — fetches live ESI prices across all 6 hubs, uses `regionPriceCache` when fresh, fetches + caches when stale. Note: `fetchRegionPrices` doesn't self-cache; helper stores explicitly via `regionPriceCache.set`.
- New AI tool #10 `get_price_comparison(item_name)`. Unlike `compare_markets` (manufactured goods only), works for **any tradeable item** — minerals, loot, moon goo, commodities. Returns `cheapest_to_buy_from`, `best_to_sell_into`, `arbitrage_opportunity`, `all_hubs` breakdown.
- Item lookup: exact LOWER() match first, then LIKE partial match fallback.
- System prompt updated with tool #10 docs and proactive trigger examples.

**Feature 2: Graceful token expiry**
- `api/client.ts`: `apiGet` + `apiPost` dispatch `forge:session-expired` CustomEvent on HTTP 401.
- `useAuth.ts`: `useEffect` listens for `forge:session-expired` → calls existing `logout()`.
- `App.tsx`: `sessionExpired` state; listens for event; resets on `auth.status === 'authed'`; passes to `LoginScreen`.
- `LoginScreen.tsx`: `sessionExpired?` prop renders amber warning banner: *"Your session has expired. Please log in again."*
- `components.css`: `.session-expired-message` — amber border/bg/text, consistent with `--color-warning`.

### v1.1 (commit `75190fc`)

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
FORGE_ADMIN_KEY=...         # protects /api/admin/* and /api/corp/admin/* endpoints
FORGE_CORP_KEY=...          # v1.4.0: any strong random string; used to derive AES-256-GCM key for refresh token encryption. REQUIRED for corp feature.
```

**Adding FORGE_CORP_KEY on server:**
```bash
# Generate a strong random key (run once, save the output)
ssh gumpy54@192.168.1.62 "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
# Add to .env on server then restart
ssh gumpy54@192.168.1.62 "echo 'FORGE_CORP_KEY=<generated-key>' >> /home/gumpy54/forge-server/.env && pm2 restart forge"
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

## 17. Corp Feature Setup Guide (v1.4.0)

### Prerequisites
1. Add `FORGE_CORP_KEY` to server `.env` (see Section 15)
2. Register corp ESI scopes on EVE Developer Portal (same app):
   - `esi-corporations.read_blueprints.v1`
   - `esi-corporations.read_assets.v1`
   - `esi-corporations.read_industry_jobs.v1`
   The director who uses the setup URL MUST have Director or Factory_Manager role in EVE.

### Corp Setup (director flow)
The director needs to authenticate with the corp scopes. Build the OAuth URL manually:
```
https://login.eveonline.com/v2/oauth/authorize
  ?response_type=code
  &client_id=<EVE_CLIENT_ID>
  &redirect_uri=<redirect_uri>
  &scope=esi-corporations.read_blueprints.v1+esi-corporations.read_assets.v1+esi-corporations.read_industry_jobs.v1+offline_access
  &state=<random>
```
After the director authorises and is redirected, extract the `code` from the URL query string.
Then call the setup endpoint (requires FORGE_ADMIN_KEY):
```bash
curl -X POST https://forge-ukc.com/api/corp/setup \
  -H "X-Admin-Key: <FORGE_ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "code": "<code_from_callback>", "redirect_uri": "<same_uri_used_above>", "pin": "123456" }'
```
This stores the encrypted refresh token, hashes the PIN, and triggers an initial ESI data pull.

### Add developer/tester to admin whitelist (bypass PIN)
```bash
curl -X POST https://forge-ukc.com/api/corp/admin/whitelist \
  -H "X-Admin-Key: <FORGE_ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "character_id": <your_character_id>, "note": "developer testing" }'
```

### View whitelist
```bash
curl https://forge-ukc.com/api/corp/admin/whitelist \
  -H "X-Admin-Key: <FORGE_ADMIN_KEY>"
```

### Remove from whitelist
```bash
curl -X DELETE https://forge-ukc.com/api/corp/admin/whitelist/<character_id> \
  -H "X-Admin-Key: <FORGE_ADMIN_KEY>"
```

### Reset corp config (start over)
```bash
curl -X DELETE https://forge-ukc.com/api/corp/admin/config \
  -H "X-Admin-Key: <FORGE_ADMIN_KEY>"
```

### Scheduled ESI refresh
Corp data (blueprints, assets, jobs) is automatically refreshed every 4 hours.
Manual trigger: POST `/api/corp/refresh` (requires EVE token + PIN/admin access).

---

## 18. Outstanding / Future Work

- **Haul cost awareness** — factor in freight cost (ISK/m³ × volume × jumps) when AI compares hub strategies
- **Production planner UI** — visual queue builder from AI recommendations
- **Material shortfall shopping list** — "what do I need to buy and where" export from RightSidebar
- **Reaction chain drill-down** — chain icon exists but multi-step reaction chains not visualised
- **ME/TE optimisation suggestions** — AI has data but no dedicated UI tool
- **Push notifications** — jobs completing while user is away
- **SKINR items** — some dynamic IDs may still show "Item #..." if not in types.json

---

## 19. Quick Reference

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
