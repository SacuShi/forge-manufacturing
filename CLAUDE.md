# FORGE — Claude Code Persistent Memory

**Read `FORGE_MEMORY.md` at the start of every session.** It is the authoritative context
document for this project: architecture, DB schema, API endpoints, EVE domain knowledge,
design decisions, and version history.

---

## Critical operational facts (always use these — do not guess or ask)

### Server
| | |
|---|---|
| IP | see local `.forge-deploy` (not committed) |
| User | see local `.forge-deploy` (not committed) |
| Server root | `/home/<server-user>/forge-server/` |
| Static files | `/home/<server-user>/forge-server/public/` |
| Database | `/home/<server-user>/forge-db/forge.db` |
| PM2 process | id `0` (use id, not name — `pm2 restart forge` may fail) |
| Public domain | `https://forge-ukc.com` |

### Deploy commands
All run from the repo root on the user's Windows PC.
**Claude cannot run these — SSH permission is denied from Claude's terminal.
Give the user the exact commands to run themselves.**

```bash
# Build frontend
cd forge-v1 && npm run build && cd ..

# Deploy backend
scp server/server.js <server-user>@<server-ip>:/home/<server-user>/forge-server/server.js

# Deploy frontend (one command — copies all hashed assets)
scp -r forge-v1/dist/* <server-user>@<server-ip>:/home/<server-user>/forge-server/public/

# Restart server
ssh <server-user>@<server-ip> "pm2 restart 0"

# Check logs
ssh <server-user>@<server-ip> "pm2 logs 0 --lines 50"
```

### Local paths
| | |
|---|---|
| Repo root | `<local repo root>` |
| Frontend source | `forge-v1\src\` |
| Frontend build output | `forge-v1\dist\` |
| Backend | `server\server.js` |
| DB (local) | `forge-db\forge.db` |
| This file | `FORGE_MEMORY.md` (full project context) |

---

## Key rules

- **Never suggest `pm2 restart forge`** — process name may not resolve. Always use `pm2 restart 0`.
- **Never deploy with `ssh` from Claude's terminal** — it will be denied. Provide commands for the user.
- **Always run `npm run build` in `forge-v1/` before deploying frontend.**
- **Vite hashes output filenames** — always deploy `dist/*` (not just `dist/assets/`).
- **FORGE_MEMORY.md is the single source of truth** — update it when significant changes are made.

---

## Engineering standards (follow these in every session)

Refactors are **no-behaviour-change**: same API routes, request/response shapes, DB schema and UI behaviour. Bugs found go in a report, not into the fix. Ask before adding dependencies, touching the SQLite schema/migrations, PM2, the Cloudflare tunnel, or AI advisor tool names/schemas/prompts. Never commit a refactor to `main`; work on a branch and commit after each phase.

### Tests (run before and after every change)
- Server: `cd server && npm test` (Vitest integration + unit, plus the script suites). The integration tests boot the real `server.js` in a throw-away copy with a seeded SQLite file and stubbed ESI/Anthropic: no network, no live DB, no tokens spent.
- Frontend: `cd forge-v1 && npm test`, `npx tsc -b` (never `tsc --noEmit false`: it writes .js files into `src`), `npm run build`, `npx eslint src`.
- Syntax checks and isolated unit tests do not catch load-order errors; only booting the server does.

### TypeScript (frontend)
- `strict` stays on. No `any` where a type is knowable; use `unknown` and narrow external data. One interface per external shape (API response, DB row) in `types/`; never re-declare it. Use `import type` for type-only imports.

### React 19
- Derived state is computed during render, not in an effect; respond to user events in the handler, not in an effect.
- Data-fetching effects must guard against stale responses (an `ignore` flag or `AbortController`).
- Do not bulk-remove existing `useMemo` / `useCallback` / `memo`; do not add them speculatively.
- One responsibility per component; split anything over about 250-300 lines at clean seams; extract reusable logic into `useXxx` hooks. Never define a component inside another component. Stable, unique `key`s (not the array index for lists that reorder or filter). No direct DOM manipulation where state would do. Keep accessibility: flag missing `alt`, unlabelled inputs, and click handlers on non-interactive elements.

### Express / Node (Express 4: the async wrapper already lives in `lib/http-errors.js`)
- One central error handler, registered last, JSON `{ error }`, no stack traces. Read configuration only through `lib/config.js`; log only through `lib/logger.js` (never log secrets). New routes: thin handler, logic in a service, SQL in a data layer; do not add more SQL to `server.js`.
- Report, do not add unasked: rate limiting, CORS scope, body-size limits, input validation, graceful shutdown.

### SQLite
- Every query is parameterised. SQL text may only be assembled from fixed fragments, `?` placeholder lists or allow-listed columns. Single-quoted string literals only. Flag N+1 patterns and multi-statement writes outside a transaction. Index suggestions go in the report.

### General
- No dead code, commented-out blocks or debug logging. Name constants (TTLs, timeouts, URLs, EVE region and station ids). Remove duplication into shared helpers. `camelCase` values, `PascalCase` components and types. Comments explain why, not what; document non-obvious EVE logic (reaction chains, ME/TE maths).
- There is no Prettier config: do not reformat files you are not otherwise changing.

### Privacy (this repository is public)
- Never commit real names, personal emails, Windows user paths, server IPs or usernames, `.env`, `FORGE_MEMORY*.md`, `HANDOFF.md`, or any credential. Commits use the GitHub noreply identity.
