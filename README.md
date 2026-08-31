# F.O.R.G.E.
**Fabrication, Operations, Resource & Guidance Engine**

EVE Online manufacturing intelligence platform for the UKC corporation.

Live at **https://forge-ukc.com** · Version **v1.6.0**

---

## What It Does

- **Market Opportunities** — pre-computed profitability across 6 trade hubs, filtered to items you can actually build with your trained skills. Sortable by profit, margin, ISK/hour, build time. Load-more pagination (50 per page).
- **True Profit panel** — full cost breakdown: material cost (ME-adjusted for blueprint + structure + rig bonuses), manufacturing job fee (live SCI × EIV + 2% SCC surcharge + facility tax), sales fee (broker fee at your actual Broker Relations + standings rate, transaction tax at your Accounting level), and haulage. T2 invention overhead (expected datacores + decryptor + job fee amortised over probability-adjusted run yield).
- **Inter-Hub Arbitrage** — scans all hub pairs for items where the buy price in one hub is lower than the sell price in another. Filters out listings with no buy orders. Shows margin, volume, freight cost, and net profit per trip.
- **Station Trading** — single-hub flip opportunities ranked by daily volume × spread. Uses your actual hub-specific broker fee rates.
- **Corp Blueprints** — ESI corp blueprint library with full product resolution (JOIN against SDE), T2 detection, ME/TE display, and runs remaining. Integrated into Market Opportunities filtering.
- **Personal Blueprints** — full ESI blueprint library: BPO/BPC detection, T2 highlighting, search/filter, per-copy run counts.
- **PI Markets** — Planetary Interaction product profitability across hubs. Correct P0–P4 tier classification per EVE SDE.
- **PI Planner** — recommends system and planet layout for a target PI chain. Scores systems by available planet types against chain requirements. Uses Fuzzwork CSVs and a hardcoded planet-resource map.
- **LP Store** — loyalty point store profitability for supported NPC corporations. Accounts for LP conversion cost, item sell price, and broker fees.
- **Assets & Appraisal** — live inventory across all characters and structures. Integrated appraisal tool: paste item names or EFT fits, get Jita/hub valuations via O(1) name→typeId reverse map.
- **Jobs tab** — active industry jobs with time remaining.
- **Production chain drill-down** — click any material to see its own build chain recursively. Chain badge shows blueprint ownership.
- **Multi-character** — add alt accounts; switch primary with fresh session timeout.
- **F.O.R.G.E. AI** — Anthropic Claude advisor with full character context injected server-side. Live tool access: wallet, blueprints, assets, jobs, skills, standings, market data, True Profit engine. Routes between Haiku (fast) and Sonnet (complex). EVE-scoped guardrails. Per-character rate limiting with automatic window pruning.

---

## Calculation Accuracy

All fees are character-specific, not generic defaults:

| Fee | How it's calculated |
|---|---|
| Broker fee | `max(1%, 3% − 0.3%×BrokerRelations − 0.03%×factionStanding − 0.02%×corpStanding)` |
| Transaction tax | `max(0%, 7.5% × (1 − 0.11×Accounting))` |
| Job fee | `SCI × EIV + EIV × 0.02 (SCC) + EIV × facilityTax` |
| Material quantity | Blueprint ME + 1% Upwell structure bonus + category rig bonus (T1 2.0%, T2 2.4% nullsec) |
| Build time | Base × (1−TE/100) × (1−0.04×Industry) × (1−0.03×AdvIndustry) × (1−structureTE/100) |
| Invention probability | Base × (1 + Encryption/40 + Σsci/30) × decryptorMult + rig/skill bonuses |

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS |
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Auth | EVE SSO OAuth 2.0 |
| AI | Anthropic Claude (claude-haiku-4-5 / claude-sonnet-4-6) |
| Process manager | PM2 |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Data sources | CCP ESI, Fuzzwork regional aggregates, CCP Adjusted Prices feed |

---

## Changelog

### v1.6.0 — 2026-08-31
- **New:** Appraisal tab — paste item names or EFT fits, get multi-hub valuations
- **New:** Inter-Hub Arbitrage tab — cross-hub flip scanner with freight cost deduction; filters items with no buy orders
- **New:** Station Trading tab — single-hub spread opportunities ranked by volume
- **New:** PI Planner tab — system/planet layout recommender for PI chains
- **New:** LP Store tab — NPC loyalty point store profitability
- **Fix:** Corp blueprints now resolve product correctly (JOIN on SDE `blueprints` table to get `product_id`; ESI returns blueprint type_id, not product type_id)
- **Fix:** PI tier classification corrected for all P0–P4 products per EVE SDE
- **Fix:** Inter-hub arbitrage no longer surfaces items with zero buy orders as profitable
- **Fix:** `makePrimary` account switch now resets the absolute 1-hour session timeout for the new primary
- **Fix:** Item name→typeId lookup in `/api/appraise` changed from O(n) scan to O(1) reverse map
- **Fix:** `_charAiWindow` AI rate-limit map now pruned periodically to prevent unbounded memory growth
- **Improvement:** True Profit panel — full tooltip breakdowns for every cost box (ME sources, fee components, broker rate derivation, invention probability breakdown)
- **Improvement:** Item icons served via disk-caching proxy (`/api/icon/:typeId`) across all tabs
- **Improvement:** SCC surcharge updated to 2% (post-Legion 2025-07-18 change from 4%)

### v1.5.1 and earlier
See git log for prior history.
