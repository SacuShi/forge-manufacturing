# F.O.R.G.E. cleanup report — branch `cleanup/refactor-pass`

Scope: a no-behaviour-change clean-up against the standards in `CLAUDE.md`. Bugs found are listed in section 6, not fixed.

## 1. Summary and versions found

| | |
|---|---|
| Node | 22.22 |
| Express | **4.22.2** (so one async wrapper, not Express 5 auto-forwarding) |
| DB driver | `sqlite3` 5.1.7 (callback API, wrapped by `dbAll` / `dbGet` / `dbRun`) |
| Frontend | React 19.2, TypeScript 6.0, Vite 8 |
| Backend language | plain JavaScript (CommonJS) — the TypeScript standards apply to the frontend only |
| Test runner (new) | Vitest 5 + supertest 7 (dev dependencies, approved) |

Commits on the branch: `8fe4d92` (Phase 1), `28d0631` (Phase 2), `9ab9e88` (Phase 3a), `d732a99` (Phase 3b), plus the Phase 4 commit.

Not applicable to this codebase: the brief's EVE Tycoon field names (`minSell`, `maxBuy`, …) do not occur anywhere in the repository; FORGE uses CCP ESI, Fuzzwork and structure markets. The only traces are a stale `connectSrc` origin in the CSP (finding 12) and a link in the AI prompt.

## 2. Scorecard (before → after)

| Area | Before | After |
|---|---|---|
| TS strictness | pass (0 errors under `--strict`) | pass |
| `any` | 0 | 0 |
| Lint | 68 problems (59 errors) | **47 (41 errors, 6 warnings)**; every remaining one is an effect/ref rule (section 6) |
| React effects (derived state) | fail — 37 `set-state-in-effect` | unchanged (see 6.8: needs per-site tests) |
| Components defined inside components | fail — 8 sites | **pass** (moved to module level) |
| Component size (>300 lines) | 12+ files | 20 files still over 300 (App.tsx 1,192; IndustrySettings 900; TradingTab 851; LPStoreTab 744; PiTab 721) — see 6.9 |
| Express error handling | fail — no central handler, 113 per-route `catch` | **pass for the centre**: one JSON error handler registered last; async rejections forwarded for all `app` and `Router` routes; per-route `catch` left as is (no behaviour change) |
| Config / env | fail — 28 scattered `process.env` reads | **pass**: `lib/config.js` is the only reader; startup warning lists unset recommended settings |
| Logging | fail — 294 raw `console.*` | **pass**: `lib/logger.js` with levels (`LOG_LEVEL`, default `info` = same output); per-request AI chatter is now `debug` |
| Security middleware | pass | pass (helmet, CORS list, 5 MB limit, per-IP + per-character AI limits) — see findings 11, 12 |
| Graceful shutdown | fail | **not changed** (rule: report only) — finding 4 |
| SQL parameterised | mostly pass | **pass after audit**: all 27 interpolated queries use fixed fragments, `?` placeholder lists or allow-listed sort columns; user text only enters as bound parameters. Double-quoted SQL literals replaced by single quotes |
| N+1 queries | not assessed | 50 queries inside loops listed (finding 3); none changed |
| Transactions | partial | report only (finding 5) |
| Tests | 7 script suites, no HTTP tests | **+ 27 Vitest server tests (18 HTTP integration, 9 unit) + 43 frontend unit tests**; all 7 script suites kept |
| Dead code | 7 candidates | 3 removed (`TabId`, `FeeRates`, `SetPins`); 3 corp response types are now used by `CorpTab`; `REMEMBER_REQUIRED_SCOPES` was a false positive (it is used) |

## 3. Changes per phase

**Phase 1 — safety net.** `server/test/harness` boots the *real* `server.js` in a throw-away copy (inside the project, git-ignored) with its own seeded SQLite file, a hand-made mini universe whose results can be worked out by hand, stubbed ESI and a scripted Anthropic; nothing touches the network or the live database. 18 supertest tests cover: authentication and validation, settings round-trip, the full True Profit arithmetic (materials at the hub station not the cheaper station elsewhere in the region, job fee from base quantities × adjusted prices, profit identity), profit lists and the pre-compute, item details, the AI advisor (plain answer, tool loop, injection guardrail, exact tool list), and isolation. A deliberate bug in the SCC rate was caught by these tests. 43 frontend unit tests cover `format`, `jobQuantity`, `hubSupply` (client copy of the pricing algorithm) and `assetSafety`.

**Phase 2 — hygiene.** Lint 68 → 47. Components created during render (`ResearchTab` sort header, `TradingTab` sort pill) moved to module level; unsafe `finally`, unused expressions/variables, empty blocks, `prefer-const`, stale `eslint-disable` directives, one dead assignment (client and server copies of the pricing walk kept identical, proven by the 200,000-case parity test). Constants that lived in component files moved out (`data/markets.ts`, `utils/tickerIntro.ts`) so component files export components only. Corp list responses are typed once and used by `CorpTab`. A wrong `formatISK` doc example corrected. No unused dependencies were found (all 8 server and both frontend dependencies are used).

**Phase 3 — structure.** `lib/config.js`, `lib/logger.js`, `lib/http-errors.js` (see scorecard). `useCanBuildNow` extracted from `App.tsx`. Earlier in the same effort (on `main`, before this brief): `RightSidebar` 2,731 → 621 lines, `MainContent` 1,367 → 692, the 871-line AI tool function moved to `lib/ai-tools.js`, one shared top-profitable SQL builder (`lib/profit-query.js`), a shared migration helper, shared haul code.

**Phase 4 — robustness.** SQL audit (section 2), double-quoted SQL literals fixed, error-path tests added (malformed JSON and oversized bodies now return JSON 400/413 instead of an HTML page with a stack trace).

Files removed from the repository earlier (privacy clean-up): internal notes, one-off rollback and patch scripts, two diagnostics needing live credentials.

## 4. Test coverage added

- Server: `npm test` → Vitest (27) + 7 script suites (hub pricing 23, industry maths 21, asset safety 9 + 3, profit query, AI tools 15 tools run against stubs, client/server pricing parity 200,000 random cases).
- Frontend: `npm test` → Vitest (43).
- Outside the repository (not committed): a larger end-to-end sandbox (81 + 68 checks against real SDE data) was re-run against this branch and passes.

## 5. Dependencies

Added (dev only, approved): `vitest`, `supertest` (server), `vitest` (frontend). Removed: none (none were unused).

## 6. Review findings

| # | File | Line | Issue | Severity | Category |
|---|------|------|-------|----------|----------|
| 1 | `server/server.js` | whole file | 12.7k-line monolith; 87 of 101 routes and all SQL live in it, so routes → services → data layering is not met | Medium | Maintainability |
| 2 | `server/server.js`, `lib/ai-tools.js` | 27 sites | SQL text assembled with `${}` (`whereClause`, `orderBy`, `ph` lists). Audited: all safe today (fixed fragments, `?` lists, allow-lists, constants). The pattern is fragile — a future edit could interpolate user text | Low | Security |
| 3 | `server/server.js` | 1062, 1088, 1149, 2165, 2636–2658, 3624, 3674, 3720–3730, 4141–4179, 4501, 5031–5045, 5154, 7474–7483, 7920–8087, 8323–8334 | 50 queries inside loops (N+1 candidates), e.g. corp refresh, hub history enrichment, queue planner. Not changed | Medium | Performance |
| 4 | `server/server.js` | 85–91 | No `SIGINT`/`SIGTERM` handler: DB and in-flight requests are not closed; PM2 may kill mid-write. Reported only, per rule | Medium | Correctness |
| 5 | `server/server.js` | various | Multi-statement writes are not consistently wrapped in transactions (6 `BEGIN` mentions in 375 queries) | Medium | Correctness |
| 6 | `server/server.js` | whole file | No input-validation library; validation is ad-hoc (`parseInt`, regex strips) | Low | Security |
| 7 | `server/server.js` | startup | 113 per-route `try/catch → res.status(500)` remain next to the new central handler | Low | Maintainability |
| 8 | frontend | see 6.8 | 37 `react-hooks/set-state-in-effect`, 3 `refs`, 1 `immutability` | Medium | Maintainability |
| 9 | frontend | see 6.9 | 20 files over 300 lines | Medium | Maintainability |
| 10 | `IndustrySettings.tsx:548`, `LPStoreTab.tsx:145`, `MainContent.tsx:555`, `RightSidebar.tsx:392`, `useItemDetail.ts:99`, `useTickerPins.ts:277` | — | `exhaustive-deps` warnings: effects/memos reading values not in their dependency list (possible stale closures, e.g. `token` in `useItemDetail`) | Medium | Correctness |
| 11 | `server/server.js` | 94–103 | CSP `scriptSrc` allows `'unsafe-inline'`, `'unsafe-eval'`, `cdn.tailwindcss.com` and `unpkg.com`; the built Vite app needs none of these. Weakens XSS protection | Medium | Security |
| 12 | `server/server.js` | 100 | CSP `connectSrc` still lists `https://evetycoon.com`; nothing in the code fetches it (the AI prompt only links to evetycoon.com pages, which are navigations, not connections) | Low | Security |
| 13 | `server/server.js` | 110 | CORS allows `http://localhost:3000` in production | Low | Security |
| 14 | `TickerBar.tsx` | 120–121 | Reads `innerRef.current.scrollWidth` during render (value lags one render) | Low | Correctness |
| 15 | `useTradingBook.ts` | 64, 106 | Writes a ref during render; `runScan` referenced inside its own callback | Low | Correctness |
| 16 | `server/server.js` | 10572 | `/api/character-fee-rates` is not called by the client (its type was removed); candidate unused endpoint | Low | Maintainability |
| 17 | `server/server.js` | schema | Index suggestions (report only): `precomputed_profits (blueprint_id, region_id)` for the cross-hub self-join, `precomputed_profits (region_id, profit)` for the main list, `corp_blueprints (corp_id)` (assets and jobs have one, blueprints do not) | Low | Performance |
| 18 | `server/server.js` | DB layer | Statements are not prepared once and reused; `sqlite3` re-prepares each call | Low | Performance |
| 19 | frontend | — | 5 click handlers on non-interactive `div`/`span`; image `alt` coverage needs a multi-line check (a naive count over-reports) | Low | Accessibility |
| 20 | `server/package.json` | — | Express 4.22: consider Express 5, which removes the need for the async wrapper | Low | Maintainability |

### 6.8 Effect findings by kind (not changed)

- *Data fetching that sets a loading flag first* (`CorpTab` ×3, `TradingTab`, `LPStoreTab`, `QueuePlannerTab`, `InterHubHaulConfig`, `PiTab`, `useCorpData`, `useItemDetail`, `useTrueCost`, …): the standard pattern; the lint rule is stricter than needed.
- *Reset state when an id changes* (`RightSidebar:267, 336, 375`, `ChainTree`, `App:435`, `IndustrySettings`, `InterHubTab`, `TradingTab:462`): should become keyed components or "adjust state during render". Each changes render timing, so each needs a component-level test first.
- *Derived values* (`MainContent:296`, `App:325`, `ResearchTab:80`, `PiPlannerTab:110`): could be computed during render.

### 6.9 Components over 300 lines

`App.tsx` 1,192 · `IndustrySettings` 900 · `TradingTab` 851 · `LPStoreTab` 744 · `PiTab` 721 · `MainContent` 692 · `ItemMaterialsSection` 653 · `HelpTab` 649 (static text) · `RightSidebar` 621 · `CorpTab` 621 · `QueuePlannerTab` 550 · `LeftSidebar` 482 · `InterHubTab` 478 · `TrueProfitPanel` 472 · `AppraisalTab` 463 and others.

## 7. Not fixed — needs a decision or is a behaviour change

1. **Effect restructuring (finding 8)** needs a component test harness (`jsdom` + `@testing-library/react`, a new dependency) so each change can be proven. Recommend adding it first.
2. **Graceful shutdown (4)**: adding it changes how PM2 restarts behave; please confirm the intended sequence.
3. **CSP (11–13)**: tightening needs a check that the deployed app runs under the stricter policy.
4. **Routes → services → data (1)** should be done domain by domain (AI, corp, trading, LP, PI), each behind the integration tests.
5. **Prettier**: not added. Running it would reformat nearly every file; recommend adopting it only for files touched from now on.
6. **`strict` mode**: already effectively on (TypeScript 6 default); 0 errors under `--strict`.
7. **Index suggestions** (17) need a look at real query plans on the production database.

## 8. Recommended next steps

1. Add `jsdom` + Testing Library and start on the keyed-reset effects.
2. Deploy `lib/config.js`, `lib/logger.js`, `lib/http-errors.js`, `lib/ai-tools.js`, `lib/profit-query.js` together with `server.js` (they are new files in `lib/`).
3. Investigate the known **item-name-resolution bug (type IDs showing as raw numbers)**: not touched here, and now easier to reproduce with the integration harness.
4. Tighten the CSP and add the shutdown handler once decided.
5. Split `App.tsx`, `IndustrySettings`, `TradingTab`, `LPStoreTab`, `PiTab` along their existing seams.
