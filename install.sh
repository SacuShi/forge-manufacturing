#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# F.O.R.G.E. — Fresh Ubuntu Install Script
# Tested on Ubuntu 22.04 / 24.04 LTS
#
# Run as a normal user with sudo access (NOT as root).
# Usage:
#   chmod +x install.sh
#   ./install.sh
#
# What this does:
#   1. Installs Node.js 22 LTS via NodeSource
#   2. Installs PM2 globally
#   3. Creates the directory structure on the server
#   4. Installs server npm dependencies
#   5. Installs frontend npm dependencies and builds the frontend
#   6. Creates a template .env file to fill in
#   7. Creates the database directory
#   8. Configures PM2 to start on boot
#
# What you must do manually AFTER running this script:
#   A. Fill in /home/$USER/forge-server/.env (see .env.example)
#   B. Run the SDE import: cd ~/forge-server && node sde-import.js
#   C. pm2 start ecosystem.config.js
#   D. Set up Cloudflared tunnel (see Section 6 of README.md)
# ─────────────────────────────────────────────────────────────────────────────

set -e  # exit on any error
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${CYAN}[FORGE]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   F.O.R.G.E. — Fresh Ubuntu Install         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────

log "Updating apt..."
sudo apt-get update -qq

log "Installing build essentials (needed for sqlite3 native module)..."
sudo apt-get install -y -qq build-essential python3 curl git tar xz-utils

# ── 2. Node.js 22 LTS ─────────────────────────────────────────────────────────

if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  ok "Node.js already installed: $NODE_VERSION"
else
  log "Installing Node.js 22 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js installed: $(node --version)"
fi

# ── 3. PM2 ────────────────────────────────────────────────────────────────────

if command -v pm2 &>/dev/null; then
  ok "PM2 already installed: $(pm2 --version)"
else
  log "Installing PM2 globally..."
  sudo npm install -g pm2
  ok "PM2 installed: $(pm2 --version)"
fi

# ── 4. Directory structure ────────────────────────────────────────────────────

log "Creating directory structure..."
mkdir -p ~/forge-server
mkdir -p ~/forge-db
ok "Directories: ~/forge-server  ~/forge-db"

# ── 5. Copy server files ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "Copying server files from repo..."
cp "$SCRIPT_DIR/server/server.js"        ~/forge-server/server.js
cp "$SCRIPT_DIR/server/forge-security.js" ~/forge-server/forge-security.js
cp "$SCRIPT_DIR/server/sde-import.js"   ~/forge-server/sde-import.js
cp "$SCRIPT_DIR/server/package.json"    ~/forge-server/package.json
ok "Server files copied"

# ── 6. Server npm dependencies ────────────────────────────────────────────────

log "Installing server npm dependencies..."
cd ~/forge-server
npm install --production
ok "Server dependencies installed"
cd "$SCRIPT_DIR"

# ── 7. Frontend build ─────────────────────────────────────────────────────────

log "Installing frontend npm dependencies..."
cd "$SCRIPT_DIR/forge-v1"
npm install
ok "Frontend dependencies installed"

log "Building frontend (tsc + vite)..."
npm run build
ok "Frontend built → forge-v1/dist/"
cd "$SCRIPT_DIR"

log "Copying frontend dist to server public dir..."
mkdir -p ~/forge-server/public
cp -r "$SCRIPT_DIR/forge-v1/dist/"* ~/forge-server/public/
ok "Frontend deployed to ~/forge-server/public/"

# ── 8. PM2 ecosystem config ───────────────────────────────────────────────────

log "Writing PM2 ecosystem config..."
cat > ~/forge-server/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name:        'forge',
    script:      './server.js',
    cwd:         '/home/' + require('os').userInfo().username + '/forge-server',
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: './logs/err.log',
    out_file:   './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
EOF
mkdir -p ~/forge-server/logs
ok "PM2 ecosystem config written"

# ── 9. .env template ─────────────────────────────────────────────────────────

if [ -f ~/forge-server/.env ]; then
  warn ".env already exists — not overwriting"
else
  log "Creating .env template..."
  cp "$SCRIPT_DIR/.env.example" ~/forge-server/.env
  warn ">>> EDIT ~/forge-server/.env with your actual values before starting! <<<"
fi

# ── 10. PM2 startup hook ──────────────────────────────────────────────────────

log "Configuring PM2 to start on system boot..."
pm2 startup | tail -1 | bash || warn "Could not auto-configure PM2 startup — run 'pm2 startup' manually"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Install complete!                          ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Next steps:"
echo -e "  ${BOLD}1.${NC} Fill in your secrets:  ${CYAN}nano ~/forge-server/.env${NC}"
echo -e "  ${BOLD}2.${NC} Run SDE import (takes ~2 min):"
echo -e "     ${CYAN}cd ~/forge-server && node sde-import.js${NC}"
echo -e "  ${BOLD}3.${NC} Start the server:"
echo -e "     ${CYAN}cd ~/forge-server && pm2 start ecosystem.config.js${NC}"
echo -e "  ${BOLD}4.${NC} Save PM2 process list:"
echo -e "     ${CYAN}pm2 save${NC}"
echo -e "  ${BOLD}5.${NC} Trigger initial precompute:"
echo -e "     ${CYAN}curl -s -X POST http://localhost:3000/api/trigger-precompute${NC}"
echo -e "  ${BOLD}6.${NC} Set up Cloudflared tunnel (see README.md Section 6)"
echo ""
