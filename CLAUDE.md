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
