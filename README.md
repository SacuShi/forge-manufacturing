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

---

## Fresh Install (Ubuntu 22.04 / 24.04)

### Prerequisites
- Ubuntu 22.04 or 24.04 LTS
- A user account with sudo access (do **not** run as root)
- Git
- A registered EVE Online developer application (see Section 3)
- An Anthropic API key (https://console.anthropic.com/)
- Cloudflare account with a domain (for the tunnel)

### 1. Clone the repo

```bash
git clone https://github.com/SacuShi/forge-manufacturing.git
cd forge-manufacturing
```

### 2. Run the install script

```bash
chmod +x install.sh
./install.sh
```

This will:
- Install Node.js 22 LTS
- Install PM2 globally
- Create `~/forge-server/` and `~/forge-db/`
- Install all server npm dependencies
- Build the React frontend
- Copy built frontend to `~/forge-server/public/`
- Write a PM2 `ecosystem.config.js`
- Create a `.env` template at `~/forge-server/.env`
- Configure PM2 to restart on system boot

### 3. Register an EVE developer app

1. Go to https://developers.eveonline.com/
2. Create a new application
3. Set the callback URL to `https://YOUR_DOMAIN/api/eve-token` (must match exactly)
4. Add these ESI scopes:
   - `esi-wallet.read_character_wallet.v1`
   - `esi-characters.read_blueprints.v1`
   - `esi-assets.read_assets.v1`
   - `esi-industry.read_character_jobs.v1`
   - `esi-skills.read_skills.v1`
5. Note your **Client ID** and **Client Secret**

### 4. Fill in environment variables

```bash
nano ~/forge-server/.env
```

See `.env.example` for all required keys and what they do. The critical ones:

| Variable | Where to get it |
|---|---|
| `EVE_CLIENT_ID` | EVE developer portal |
| `EVE_CLIENT_SECRET` | EVE developer portal |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| `FORGE_CORP_KEY` | `openssl rand -hex 32` |
| `FORGE_ADMIN_KEY` | `openssl rand -hex 24` |

### 5. Run the SDE import

This downloads EVE's static data (~200 MB) and populates the database with all items, blueprints, skills, reaction formulas, and item names (including faction items, clothing, SKINs).

```bash
cd ~/forge-server
node sde-import.js
```

Takes approximately 2–5 minutes. You should see 7 steps completing with ✓. Re-run this whenever CCP releases a major patch.

### 6. Start the server

```bash
cd ~/forge-server
pm2 start ecosystem.config.js
pm2 save
```

Verify it's running:
```bash
pm2 status
curl http://localhost:3000/api/health
```

Trigger the initial profit precompute (runs automatically every 6 hours but kick it off manually first):
```bash
curl -s -X POST http://localhost:3000/api/trigger-precompute
```

Watch it compute across all 6 trade hubs:
```bash
pm2 logs forge --lines 60
```

### 7. Set up Cloudflared tunnel

FORGE uses a Cloudflare tunnel to expose the local server over HTTPS without opening ports.

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Authenticate (opens browser)
cloudflared tunnel login

# Create the tunnel
cloudflared tunnel create forge

# Create config
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /home/$USER/.cloudflared/<YOUR_TUNNEL_ID>.json
ingress:
  - hostname: forge-ukc.com
    service: http://localhost:3000
  - service: http_status:404
EOF

# Add DNS record (replace with your domain)
cloudflared tunnel route dns forge forge-ukc.com

# Run as a service
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

---

## Updating an Existing Install

When deploying changes from the Windows dev machine:

```bash
# Build frontend
cd forge-v1 && npm run build && cd ..

# Deploy (from Windows terminal — SSH from Claude's terminal is blocked)
scp server/server.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/server.js
scp server/forge-security.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/forge-security.js
scp -r forge-v1/dist/* gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/

# Restart
ssh gumpy54@192.168.1.62 "pm2 restart 0"
```

> **Important:** Always deploy `index.html` and `assets/` together — Vite hashes filenames on every build. Deploying one without the other causes white-screen errors.

---

## Database

The database (`~/forge-db/forge.db`) is **not in the repo** (SQLite binary). On a fresh install:

1. `server.js` auto-creates all tables on first startup via `CREATE TABLE IF NOT EXISTS`
2. `sde-import.js` populates the SDE data (items, blueprints, skills, reaction formulas)
3. The precompute engine fills `precomputed_profits` on startup and every 6 hours

**Migrating an existing database:** just `scp` the `.db` file to the new server — no schema migration needed as long as you run `pm2 restart` once (auto-migrations run on startup).

```bash
scp gumpy54@OLD_IP:/home/gumpy54/forge-db/forge.db ~/forge-db/forge.db
```

---

## Directory Layout on Server

```
~/forge-server/
├── server.js              ← Express backend
├── forge-security.js      ← Auth + rate limiting middleware
├── sde-import.js          ← SDE population script
├── package.json           ← Server npm dependencies
├── ecosystem.config.js    ← PM2 config (generated by install.sh)
├── .env                   ← Secrets (not in repo)
├── public/                ← Built React frontend (deployed from forge-v1/dist/)
│   ├── index.html
│   └── assets/
│       ├── index-[hash].js
│       └── index-[hash].css
└── logs/
    ├── out.log
    └── err.log

~/forge-db/
└── forge.db               ← SQLite database (not in repo)
```

---

## Useful Commands

```bash
# Check server status
pm2 status
pm2 logs forge --lines 50

# Trigger precompute manually
curl -s -X POST http://localhost:3000/api/trigger-precompute

# Health check
curl http://localhost:3000/api/health

# Re-run SDE import (after EVE patch)
pm2 stop 0
cd ~/forge-server && node sde-import.js
pm2 start 0
curl -s -X POST http://localhost:3000/api/trigger-precompute

# Check AI costs
curl -H "X-Admin-Key: YOUR_FORGE_ADMIN_KEY" http://localhost:3000/api/admin/ai-costs
```

---

## EVE Online Resources

| Resource | URL |
|---|---|
| ESI (API) | https://esi.evetech.net/ui/ |
| EVE SSO | https://developers.eveonline.com/ |
| ESI Swagger | https://esi.evetech.net/latest/ |
| everef SDE | https://data.everef.net/ |
| EVE Image Server | https://images.evetech.net/types/{typeId}/icon?size=32 |

---

## Project Context for AI Assistants

See `FORGE_MEMORY.md` — comprehensive context document covering architecture, all API endpoints, DB schema, design decisions, EVE domain knowledge, and version history. Read it at the start of any Claude session.
