# FORGE — Persistent Project Memory

> This file is the authoritative context document for Claude sessions working on this project.
> Read this first. Update it whenever significant decisions, changes, or discoveries are made.
> Last updated: v1.0.0.0 + load-more pagination

---

## 1. What FORGE Is

**F.O.R.G.E.** — Fabrication, Operations, Resource & Guidance Engine

An EVE Online manufacturing intelligence web application for the **UKC corporation**. It connects to the EVE ESI (EVE Swagger Interface) API via OAuth, loads a player's character data (blueprints, assets, skills, jobs, wallet), and provides:

- **Market Opportunities tab** — pre-computed profitability ranked by profit/margin/ISK-per-hour, filtered to only show items the character can actually build given their trained skills
- **Blueprints tab** — full ESI blueprint library with BPO/BPC detection, T2 highlighting, search/filter
- **Assets tab** — inventory grouped by type with quantity sums
- **Jobs tab** — active industry jobs with time remaining
- **Right sidebar** — drill-down production chain for any item; chain badge if a blueprint exists in the game DB
- **AI chat panel (F.O.R.G.E. AI)** — Anthropic Claude advisor with live character context, 7 tools, history persistence

**Live domain:** https://forge-ukc.com  
**GitHub:** https://github.com/SacuShi/forge-manufacturing.git  
**Current version:** v1.0.0.0 (4-part scheme: major.feature.change.patch)

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

### CRITICAL deployment note
Vite hashes output filenames on every build (e.g. `index-DgGW3P7F.js`). If you upload `index.html` but not `assets/` (or vice versa), the browser gets `NS_ERROR_CORRUPTED_CONTENT` / MIME type mismatch because `index.html` references files that don't exist yet. **Always upload both together.**

### Local paths
| Item | Path |
|---|---|
| Repo root | `C:\Users\AndyMcD\Desktop\forge-manufacturing` |
| Frontend source | `C:\Users\AndyMcD\Desktop\forge-manufacturing\forge-v1\src\` |
| Frontend dist | `C:\Users\AndyMcD\Desktop\forge-manufacturing\forge-v1\dist\` |
| Backend | `C:\Users\AndyMcD\Desktop\forge-manufacturing\server\` |
| Active worktree | `C:\Users\AndyMcD\Desktop\forge-manufacturing\.claude\worktrees\hardcore-lamport-8943e7\` |

> The worktree branch `claude/hardcore-lamport-8943e7` was where the v1.0 production frontend was developed. After v1.0.0.0 the main repo was synced and is now the source of truth. Both have identical src/.

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
| EVE ESI | https://esi.evetech.net | Character data (blueprints, assets, skills, jobs, wallet) |
| EVE SSO | https://login.eveonline.com | OAuth authentication |
| EVE Image Server | https://images.evetech.net | Item/character icons |
| everef.net | https://data.everef.net/reference-data/reference-data-latest.tar.xz | SDE reference data |
| Anthropic API | claude-3-5-sonnet (or current) | AI advisor |

---

## 4. Repository Structure

```
forge-manufacturing/
├── server/
│   ├── server.js           ← Express backend (v1.0.0.0)
│   ├── sde-import.js       ← SDE import script (v2)
│   └── forge-security.js   ← Auth + rate limiting middleware
├── forge-v1/
│   ├── src/
│   │   ├── App.tsx             ← Root: auth states, market data, chat logic
│   │   ├── main.tsx
│   │   ├── api/
│   │   │   └── client.ts       ← apiGet / apiPost helpers
│   │   ├── components/
│   │   │   ├── Header.tsx      ← Top bar with "Ask F.O.R.G.E. AI" button
│   │   │   ├── LeftSidebar.tsx ← Character card, nav tabs, quick prompts, jobs
│   │   │   ├── MainContent.tsx ← Tabs: Market, Blueprints, Assets, Jobs
│   │   │   ├── RightSidebar.tsx← Item detail panel, price chart, chain drill-down
│   │   │   ├── ChatPanel.tsx   ← AI chat slide-in panel
│   │   │   ├── ItemTable.tsx   ← Sortable market opportunities table
│   │   │   ├── ItemLink.tsx    ← Clickable item token in chat messages
│   │   │   ├── LoginScreen.tsx ← EVE SSO login page
│   │   │   └── LoadingScreen.tsx← Step-by-step data load progress log
│   │   ├── hooks/
│   │   │   ├── useAuth.ts      ← Token exchange, ESI data loading, session state
│   │   │   ├── useItemDetail.ts← Item detail API calls
│   │   │   └── useItemNames.ts ← Item name lookups from DB
│   │   ├── styles/
│   │   │   ├── variables.css   ← CSS design tokens (dark/light mode)
│   │   │   ├── global.css      ← Reset, app shell, scrollbars
│   │   │   └── components.css  ← All component styles
│   │   ├── types/
│   │   │   └── index.ts        ← All shared TypeScript interfaces
│   │   ├── data/
│   │   │   └── mockData.ts     ← QUICK_PROMPTS constant + any static data
│   │   └── utils/
│   │       └── format.ts       ← formatBuildTime, ISK formatters
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig*.json
├── CHANGELOG.md            ← Full change history since origin push
├── FORGE_MEMORY.md         ← THIS FILE
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
Populated by `sde-import.js` Step 6 from `types.json` — covers ALL published EVE types (~50k+), including faction items, clothing, SKINs, etc.

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
Created by `sde-import.js` Step 2. Used by `/api/top-profitable-by-skills` to filter results to buildable blueprints.

#### `precomputed_profits`
```sql
blueprint_id    INTEGER
product_id      INTEGER
product_name    TEXT
material_cost   REAL
sell_price      REAL
buy_price       REAL
profit          REAL
profit_margin   REAL
isk_per_hour    REAL
build_time      INTEGER
material_count  INTEGER
computed_at     TEXT
avg_daily_volume REAL
market_group_id INTEGER
liquidity_risk  TEXT   -- NULL/""/low_volume/contract_only/extreme_margin/no_buy_orders/suspicious_spread
activity_id     INTEGER DEFAULT 1
```
Rebuilt every 6 hours by the precompute engine. Triggered manually via `POST /api/trigger-precompute`.

#### `precompute_runs`
```sql
id                  INTEGER PRIMARY KEY
completed_at        TEXT
blueprints_processed INTEGER
duration_seconds    REAL
status              TEXT
```

---

## 6. API Endpoints

All endpoints require `Authorization: Bearer <eve_token>` unless noted. Rate limited via `security.apiLimiter`.

### Authentication
| Method | Path | Notes |
|---|---|---|
| GET | `/api/eve-token` | EVE SSO OAuth callback — exchanges code for tokens |

### Market
| Method | Path | Params | Notes |
|---|---|---|---|
| GET | `/api/top-profitable-by-skills` | `limit` (default 50, max 200), `offset` (default 0), `sort` (profit/margin/isk_per_hour/cost/sell_price), `minProfit`, `minVolume`, `includeRisky` | Skill-filtered pre-computed profitability. Fetches `(offset+limit)*3` candidates from DB then filters by `blueprint_skills`. Returns `{results, meta: {hasMore, offset, count, lastComputed, ...}}` |
| GET | `/api/top-profitable` | `limit`, `sort`, etc. | Unfiltered version (admin/debug use) |

### Item Detail
| Method | Path | Notes |
|---|---|---|
| POST | `/api/item-details` | Body: `{typeId, characterId}`. Returns name, icon, price history, current Jita prices, build analysis with materials (each has `canManufacture` flag from bulk DB query), profit/margin |
| POST | `/api/blueprint-metadata` | Body: `{blueprintTypeIds: number[]}`. Returns bulk `meta_level` map for blueprint type_ids |

### Session Cache
| Method | Path | Notes |
|---|---|---|
| POST | `/api/session-data` | Caches character session (assets, blueprints, skills, jobs, wallet) for 2 hours. Required before using AI |
| GET | `/api/session-data/:characterId` | Inspect cached session |
| POST | `/api/invalidate-session` | Clear session cache |

### Chat / AI
| Method | Path | Notes |
|---|---|---|
| POST | `/api/ai-chat` | Body: `{messages: [{role, content}]}`. Uses Anthropic Claude with prompt caching. Context injected server-side from session cache. History capped at 10 messages per request |
| GET | `/api/chat-history/:characterId` | Returns persisted chat messages |
| POST | `/api/save-message` | Body: `{characterId, role, content, conversationId}`. Persists one message |
| DELETE | `/api/chat-history/:characterId` | Clears history |

### Admin / Debug
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/ai-costs` | AI usage tracking: token counts + estimated cost |
| GET | `/api/diagnose-t2/:characterId` | T2 blueprint DB coverage diagnostics |
| POST | `/api/trigger-precompute` | Manually trigger the 6-hour precompute cycle |

### AI Tools (internal — used by `/api/ai-chat`)
`get_precomputed` (supports `activityType`: all/manufacturing/reaction), `analyze_blueprints`, `get_blueprint`, `get_price`, `get_active_jobs`, `get_t2_blueprints`, `diagnose_blueprints`

---

## 7. Frontend Architecture

### Auth flow (`useAuth.ts`)
```
idle → (EVE SSO redirect) → exchanging → loading → authed
                                                  ↘ error
```
- `idle`: show LoginScreen
- `exchanging`: code→token exchange in progress
- `loading`: ESI data loading (blueprints, assets, skills, jobs, wallet) + session cache POST
- `authed`: full app rendered

### State in `App.tsx`
| State | Type | Purpose |
|---|---|---|
| `theme` | `'dark'|'light'` | Persisted to localStorage |
| `chatOpen` | `boolean` | Chat panel visible |
| `chatAutoOpened` | `boolean` | Was chat auto-opened (closes on outside click) |
| `marketItems` | `MarketItem[]` | Mapped display items (all loaded pages) |
| `rawResults` | `TopProfitableResponse['results']` | Raw API results for `selectedDetail` lookups |
| `marketHasMore` | `boolean` | Whether more pages exist on server |
| `marketLoadingMore` | `boolean` | "Load next 50" in-flight |
| `selectedTypeId` | `number|null` | Currently selected item (drives RightSidebar) |
| `panelHistory` | `Array<{typeId,name}>` | Back-stack for chain drill-down |
| `chatMessages` | `ChatMessage[]` | Full conversation history |

### Load-More pagination
- Initial fetch: `/api/top-profitable-by-skills?limit=50`
- Each "Load next 50": offset = `rawResults.length` (always accurate)
- New items appended; ranks continue from previous last rank
- `mapToMarketItems(results, blueprints, rankOffset)` — rankOffset ensures ranks are 51, 52... on page 2

### Auto-open chat
- Chat panel auto-opens in `.finally()` of the market data fetch (every login)
- Welcome message: action-oriented ("Your data is ready…")
- If `chatAutoOpened === true`: any click outside `.chat-panel` in `.app-body` closes it
- Manual toggle clears `chatAutoOpened` flag

### RightSidebar chain drill-down
- `canManufacture` flag: set server-side via bulk SQL `SELECT DISTINCT product_id FROM blueprints WHERE product_id IN (...)`
- Two badge states: `⛓ owned` (purple) if user has the blueprint, `⛓ chain` (cyan) if game blueprint exists but user doesn't own it
- Back-navigation stack (`panelHistory`) — ← button traverses drill-down history

---

## 8. Design System

### CSS Variables (variables.css)
Dark mode is default (`:root`). Light mode via `[data-theme='light']`. Also honours `prefers-color-scheme`.

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
- `.btn-chat` — "Ask F.O.R.G.E. AI" button; has `@keyframes forge-ai-pulse` 5s glow cycle; `animation: none` when `.open`
- `.pill-filter` — rounded filter chip (All / Can Build / BPO / BPC)
- `.bp-icon-bpo` — dark navy bg, cyan border (`#4fc3f7`)
- `.bp-icon-bpc` — cyan tint bg, dark navy border
- `.bp-icon-t2` — dark navy bg, orange border (`#ff9800`)
- `.mat-row-clickable` — hover highlight on material rows
- `.chat-panel` — 0 width when closed, `var(--chat-panel-width)` when `.open` (CSS transition)
- `.sidebar-overlay` — tablet/mobile dim overlay

### Animations
```css
@keyframes forge-spin   /* loading spinner — in global.css */
@keyframes forge-ai-pulse  /* AI button glow — in components.css */
```

---

## 9. EVE Online Domain Knowledge

### Blueprint ownership detection
```typescript
// ESI field: runs
const isBPO = bp.runs === -1;          // Original — infinite runs
const isBPC = bp.runs >= 0;            // Copy — limited runs
// WRONG: quantity === -1 is singleton flag, NOT BPO indicator
```

### activity_id values (ESI + blueprints table)
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

### Liquidity risk tiers (precomputed_profits)
1. `contract_only` — item only traded on contracts, not open market
2. `extreme_margin` — buy/sell spread > 50%
3. `low_volume` — fewer than 5 units/day average (WARNING level, not filtered by default)
4. `no_buy_orders` / `suspicious_spread` — no active buy orders

### Market data
- All prices from **Jita 4-4** (The Forge region — main trade hub)
- Sell price = best sell order
- Buy price = best buy order
- Volume enrichment: 30-day average daily volume + `market_group_id` from ESI

---

## 10. SDE Import (sde-import.js v2)

Downloads `reference-data-latest.tar.xz` from `https://data.everef.net/reference-data/`.  
Both `types.json` and `blueprints.json` parsed **once** in `main()` and passed to all steps.

| Step | Function | What it does |
|---|---|---|
| 1 | `addMetaLevel(typesData)` | Bulk UPDATE `items.meta_level` (T2=1, T3=2) |
| 2 | `importBlueprintSkills(bpData)` | Creates + populates `blueprint_skills` table |
| 3 | `importReactionFormulas(bpData)` | Imports reaction blueprints with `activity_id=9` |
| 4 | `ensureReactionItems(bpData, typesData)` | Inserts moon goo, gas, reaction components not yet in `items` |
| 5 | `ensureAllBlueprintItems(typesData)` | Ensures all blueprint_id/product_id/material_ids are in `items` |
| 6 | `importAllTypes(typesData)` | **Bulk INSERT OR UPDATE** all ~50k types — covers faction items, clothing, SKINs, SKINR, implants, LP store items, etc. Uses `ON CONFLICT DO UPDATE` so correct names are never clobbered |
| 7 | `verify()` | Reports counts; flags any unnamed blueprints |

### Why Step 6 exists
Before Step 6, items not referenced by any blueprint (faction modules, clothing, SKINR components) showed as "Item #12345" in the Assets tab because they were never inserted into the `items` table. Step 6 fixes this permanently.

---

## 11. AI Advisor Architecture

### Token efficiency measures
- All `// ═══...═══` decorator comment lines removed from server.js (~975 tokens saved per file read)
- Tool descriptions trimmed ~60%
- AI conversation history: capped at 10 messages per request (slice `-10` both client-side and server-side)
- Anthropic prompt caching (`cache_control: { type: "ephemeral" }`) on system prompt
- Bulk SQL for material queries (2 queries per item-details call instead of N)

### Server-side context injection
The AI receives character context from the session cache — **nothing sensitive is sent from the client**:
- Wallet balance
- Blueprint library
- Asset inventory
- Active jobs
- Trained skills

### Chat persistence
- Messages saved to DB via `POST /api/save-message` after each send/receive
- Loaded on login via `GET /api/chat-history/:characterId`
- History capped at 20 messages restored (last 20 if longer)
- Clear via `DELETE /api/chat-history/:characterId`

---

## 12. Development History & Key Decisions

### Origin → v0.9.x (before Claude sessions)
- Express backend with SQLite for blueprint/item data
- Price fetching from Jita 4-4 (all pages)
- Basic profitability calculation
- `portionSize` profit bug fixed
- Token optimisations

### v0.9.2.x–v0.9.4 (early Claude work)
- Multi-market backend foundation (v0.9.4)
- AI advisor added with live player context
- Skills session caching
- `/api/top-profitable-by-skills` endpoint

### v1.0.0.0 (major Claude session — complete rewrite)

**Frontend:** Complete rewrite from mock-data prototype to live authenticated app.
- `useAuth` hook with full OAuth lifecycle
- `LoadingScreen` with step-by-step progress log
- Market Opportunities tab with live precomputed data
- Blueprints tab: BPO/BPC grouping fix (was using `quantity === -1`, fixed to `runs === -1`)
- Right sidebar chain drill-down with `canManufacture` from server
- AI chat panel with history, quick prompts, server-side context
- Dark/light theme toggle

**Backend:** Version bump to 1.0.0.0; 4-part version scheme established.
- Bulk SQL for material queries (N queries → 2 bulk queries)
- `canManufacture` flag via `SELECT DISTINCT product_id FROM blueprints`
- DB migrations: `items.meta_level`, `blueprints.activity_id`, `precomputed_profits.activity_id`
- Rate limiting, token verification on all sensitive endpoints

**SDE import v2:** everef.net single-archive approach replacing Hoboleaks piecemeal downloads.

**Version scheme established:** `major.feature.change.patch`
- `1` = major version / full rewrite
- `0` = feature additions
- `0` = changes to existing features
- `0` = patches/fixes

### Post-v1.0.0.0 patches
| Commit | Change |
|---|---|
| `78c2888` | sde-import Step 6: bulk import ALL types.json — fixes faction/clothing/SKINR item names |
| `8729ad8` | "Ask F.O.R.G.E. AI" button label; 5s pulse glow animation; auto-open chat on login |
| `1713c9e` | Quick prompt chips: remove 40-char truncation |
| `7fb861a` | Load-more pagination: `offset` param on server; "Load next 50" button in Market tab |

---

## 13. Known Patterns & Conventions

### API calls
```typescript
// client.ts helpers
apiGet<T>(path: string, token: string): Promise<T>
apiPost<T>(path: string, body: object, token: string): Promise<T>
```

### Token in requests
```typescript
headers: { 'Authorization': `Bearer ${auth.token}` }
```

### Item icons
```
https://images.evetech.net/types/{typeId}/icon?size=32
https://images.evetech.net/characters/{characterId}/portrait?size=32
```

### Error handling pattern
```typescript
.catch((e: Error) => setError(e.message))
onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
```

### DB helper pattern (server.js)
```javascript
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
```

### Bulk SQL pattern (canManufacture)
```javascript
const ph = matIds.map(() => '?').join(',');
const manufRows = await dbAll(
  `SELECT DISTINCT product_id FROM blueprints WHERE product_id IN (${ph})`,
  matIds
);
const manufSet = new Set(manufRows.map(r => r.product_id));
// then: canManufacture: manufSet.has(mat.material_id)
```

### React component conventions
- Functional components only (`FC<Props>`)
- `useCallback` for all handlers passed as props
- `useMemo` for derived/filtered lists
- Inline styles for one-off layout; CSS classes for reusable styling
- `aria-label`, `role`, `aria-pressed` used throughout for accessibility

---

## 14. Environment Variables (.env on server)

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

## 15. Security Model

- All AI/session/item endpoints require verified EVE token (`security.verifyEveToken`)
- Token verification confirms EVE SSO signature, not just presence
- Character ownership validation on history/session endpoints (can't read another character's data)
- Rate limiting on all public endpoints via `security.apiLimiter`
- Input validation middleware on AI chat and message save endpoints
- Helmet CSP configured for EVE SSO + ESI domains
- Cloudflared proxy (`app.set('trust proxy', 1)`)
- Nothing sensitive (session data, skills, assets) sent from client — server injects from session cache

---

## 16. Outstanding / Future Work

- **Multi-market support** — foundation was started in v0.9.4 but not completed; currently Jita 4-4 only
- **SKINR items** — may still show "Item #..." for some if types.json doesn't cover them (Step 6 helps but some may be dynamic/generated IDs)
- **Reaction chain drill-down** — chain icon exists for reaction products but full multi-step reaction chain not yet visualised
- **ME/TE optimisation suggestions** — AI has the data but no dedicated UI tool
- **Push notifications** — jobs completing while user is away

---

## 17. Quick Reference

### Rebuild & deploy (full)
```bash
# 1. Make changes
# 2. Build
cd "C:\Users\AndyMcD\Desktop\forge-manufacturing\forge-v1" && npm run build
# 3. Deploy
scp server/server.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/server.js
scp forge-v1/dist/index.html gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/index.html
scp -r forge-v1/dist/assets gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/
ssh gumpy54@192.168.1.62 "pm2 restart forge"
# 4. Commit
cd "C:\Users\AndyMcD\Desktop\forge-manufacturing"
git add -A -- ':!.claude/' ':!.clone/'
git commit -m "feat/fix: description"
git push origin main
```

### Check server logs
```bash
ssh gumpy54@192.168.1.62 "pm2 logs forge --lines 50"
```

### Trigger precompute manually
```bash
ssh gumpy54@192.168.1.62 "curl -s -X POST http://localhost:3000/api/trigger-precompute"
```

### Health check
```
GET https://forge-ukc.com/api/health
```
