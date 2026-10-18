# FORGE Changelog

## v1.0.0.0 — 2026-05-17

First production release. Complete rewrite of the frontend from a mock-data prototype to a fully authenticated, live-data application. Major backend additions including pre-computed profitability, AI advisor, SDE import pipeline, and reaction formula support.

---

### Frontend — complete production rewrite

**Authentication & session**
- EVE SSO OAuth flow via `/api/eve-token` — full login/logout lifecycle
- `useAuth` hook manages token exchange, ESI data loading, and session state
- Loading screen with step-by-step progress log during data fetch
- Session data (assets, blueprints, skills, jobs, wallet) cached server-side for AI queries

**Market Opportunities tab**
- Live pre-computed profitability data from `/api/top-profitable-by-skills`
- Results filtered by character's trained skills — only shows items the character can build
- Sortable table: profit, margin, ISK/hour, build time
- Search + pill filters (All / Can Build / BPO / BPC)
- Mini stats bar: buildable count, top profit, average margin

**Blueprints tab**
- Full ESI blueprint library rendered from live character data
- Grouped by `type_id` — multiple BPCs of the same blueprint shown as one card with per-copy run counts
- Fixed BPO/BPC detection: uses `runs === -1` (not `quantity === -1`) so singleton T2 BPCs now correctly appear under the BPC filter
- BPC filter now shows all copies including singleton BPCs (previously only showed stacked BPCs)
- T2 blueprints highlighted via `meta_level` from server
- Search by blueprint name

**Assets tab**
- ESI asset inventory grouped and summed by type, sorted by quantity
- Item icons via EVE image server

**Jobs tab**
- Active industry jobs with activity label (Manufacturing, Reaction, Invention, etc.)
- Time remaining display

**Right sidebar — item detail panel**
- Drill-down production chain: clicking any manufacturable material opens that item's detail
- Back-navigation stack (← button) through chain history
- `canManufacture` flag now set server-side via blueprints DB lookup — chain icon appears for any item with a game blueprint, not just user-owned ones
- Chain badge: purple `⛓ owned` if user has the blueprint, cyan `⛓ chain` if game blueprint exists
- Material rows: bulk SQL queries replace per-material individual queries (performance)
- Price history chart, current Jita prices, build analysis with asset shortfall

**AI Chat panel**
- Slide-in panel with full conversation history
- Quick-prompt chips
- Thinking indicator
- Clear history button
- Chat history persisted server-side, restored on login

**Theme**
- Dark/light toggle, persisted to localStorage
- Mobile drawer + overlay for sidebar navigation

**Favicon**
- Replaced placeholder with FORGE hexagon logo: cyan outline, bold F, UKC corp tag

---

### Backend — server.js (v1.0.0.0)

**Versioning**
- Established 4-part version scheme: `major.feature.change.patch`
- Removed legacy dual-version labelling

**New endpoints**
- `GET /api/top-profitable-by-skills` — filters pre-computed results by character's trained skills using `blueprint_skills` table
- `POST /api/blueprint-metadata` — single bulk query returns `meta_level` for an array of blueprint type_ids
- `POST /api/session-data` — caches character session (assets, blueprints, skills, jobs, wallet) for 2 hours
- `GET /api/session-data/:characterId` — session cache inspection
- `POST /api/invalidate-session` — clears session cache
- `GET /api/chat-history/:characterId` — returns persisted chat history
- `POST /api/save-message` — persists individual chat messages
- `DELETE /api/chat-history/:characterId` — clears chat history
- `GET /api/diagnose-t2/:characterId` — diagnoses T2 blueprint DB coverage
- `POST /api/trigger-precompute` — manual precompute trigger

**Database migrations** (auto-run on startup)
- `items.meta_level INTEGER` — T2/T3 classification (0=T1, 1=T2, 2=T3)
- `blueprints.activity_id INTEGER` — manufacturing (1) vs reaction (9)
- `precomputed_profits.activity_id INTEGER` — propagated from blueprints

**Pre-compute engine**
- Calculates profitability for all blueprints on startup and every 6 hours
- In-memory batch processing (no per-blueprint DB round-trips)
- Stores `activity_id` so reactions appear separately from manufacturing
- Volume enrichment job: fetches 30-day average daily volume + `market_group_id` from ESI
- 4-tier liquidity risk filtering: `contract_only`, `extreme_margin`, `low_volume`, `no_buy_orders`/`suspicious_spread`

**AI advisor**
- Anthropic Claude integration with prompt caching (`cache_control: ephemeral`)
- Server-side context injection (wallet, blueprints, assets, jobs, skills) — nothing sensitive sent from client
- Tool suite: `get_precomputed`, `analyze_blueprints`, `get_blueprint`, `get_price`, `get_active_jobs`, `get_t2_blueprints`, `diagnose_blueprints`
- `get_precomputed` supports `activityType` filter (all / manufacturing / reaction)
- Conversation history capped at 10 messages per request
- AI usage tracking: input/output tokens + estimated cost logged per request
- Admin endpoint `GET /api/admin/ai-costs` for cost monitoring

**Token efficiency**
- All decorative comment separators removed (~975 tokens saved per file read)
- Tool descriptions trimmed ~60% (saved per every AI API call)
- `/api/blueprint-metadata`: N individual queries → single bulk query
- `get_t2_blueprints` AI tool: N queries → single bulk query
- `/api/item-details` material loop: per-material name + blueprint queries → two bulk queries upfront
- `canManufacture` flag added to each material via bulk `SELECT DISTINCT product_id FROM blueprints`

**Security**
- All AI/session endpoints require verified EVE token (`security.verifyEveToken`)
- Character ownership validation on history/session endpoints
- Rate limiting on all public endpoints
- Input validation middleware on AI chat and message save

**Removed**
- `isT2ByName()` function (replaced by `meta_level` column from SDE import)
- Hardcoded T2 name-pattern matching throughout

---

### SDE Import — sde-import.js (v2)

Complete rewrite. Replaced piecemeal Hoboleaks downloads with a single `reference-data-latest.tar.xz` from `data.everef.net`.

**Step 1 — meta_level**
- Parses `types.json` for `meta_group_id` (2=T2, 14=T3)
- Bulk UPDATE `items.meta_level` in chunks of 500

**Step 2 — blueprint_skills**
- Creates `blueprint_skills` table (blueprint_id, skill_id, skill_level, activity_id)
- Parses `blueprints.json` `required_skills` keyed object (not legacy array format)
- Covers all activities: manufacturing, research, copying, invention, reaction

**Step 3 — reaction formulas**
- Adds `activity_id` column to `blueprints` table
- Imports all reaction blueprints with `activity_id=9`
- Imports reaction materials into `blueprint_materials`

**Step 4 — reaction component items**
- Collects all type_ids referenced in reaction formulas
- Inserts missing ones from `types.json` into `items` table (name + meta_level)
- Handles both string and `{ en: "..." }` name formats

**Step 5 — all blueprint items**
- Queries `blueprints` + `blueprint_materials` for every referenced type_id
- Inserts any missing items from `types.json`
- Ensures all blueprint names, product names, and material names resolve in the UI
- Fixes "Blueprint #89485" style unnamed entries

**Step 6 — verification**
- Reports T2 item count, skill rows, manufacturing/reaction blueprint counts
- Reports count of blueprints with no name (should be 0 after full import)

**Performance**
- `types.json` and `blueprints.json` each parsed once and shared across all steps
- All bulk INSERTs wrapped in transactions

---

### Removed
- `FORGE-MULTIMARKET-FEATURE-PROPOSAL-v1.md.txt` — superseded
