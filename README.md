# F.O.R.G.E.
**Fabrication, Operations, Resource & Guidance Engine**

EVE Online manufacturing intelligence platform for the UKC corporation.

Live at **https://forge-ukc.com**  · Version **v1.5.1**

---

## What It Does

- **Market Opportunities** — pre-computed profitability across 6 trade hubs, filtered to items you can actually build with your trained skills. Sortable by profit, margin, ISK/hour, build time. Load-more pagination (50 per page).
- **True Profit panel** — material cost, manufacturing fees (using real system cost indexes + structure rigs), sales tax, and actual profit per run.
- **Blueprints tab** — full ESI blueprint library: BPO/BPC detection, T2 highlighting, search/filter, per-copy run counts.
- **Assets & Jobs tabs** — live inventory and active industry jobs.
- **Production chain drill-down** — click any material to see its own build chain recursively. Chain badge shows whether you own the blueprint or just a game blueprint exists.
- **Multi-character** — add alt accounts; combined view across all characters.
- **F.O.R.G.E. AI** — Anthropic Claude advisor with full character context injected server-side. Knows your wallet, blueprints, assets, jobs, skills, and live market data. 9 tools.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Backend | Node.js + Express |
| Database | SQLite (sqlite3) |
| Auth | EVE SSO OAuth 2.0 |
| AI | Anthropic Claude (claude-sonnet-4-6) |
| Proxy | Cloudflared tunnel |
