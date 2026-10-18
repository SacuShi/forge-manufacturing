#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# F.O.R.G.E. — Docker entrypoint
#
# On first run (no DB file):
#   1. Briefly starts server.js to create all DB tables via CREATE TABLE IF NOT EXISTS
#   2. Stops that process
#   3. Runs sde-import.js to populate SDE data (~2-5 min, ~200 MB download)
#
# On subsequent runs:
#   - Skips SDE import, starts server directly
#
# The SDE import flag file is stored in the DB directory so it persists
# across container rebuilds.
# ─────────────────────────────────────────────────────────────────────────────

set -e

DB_DIR="/forge-db"
DB_FILE="$DB_DIR/forge.db"
SDE_FLAG="$DB_DIR/.sde-imported"

# Ensure DB directory exists (should be mounted, but safety check)
mkdir -p "$DB_DIR"

if [ ! -f "$SDE_FLAG" ]; then
  echo "[FORGE] First run detected — initialising database..."

  # Step 1: Start server briefly to create schema (tables are created on startup)
  echo "[FORGE] Creating database schema..."
  node /app/server.js &
  SERVER_PID=$!

  # Wait for the server to be ready. Poll 127.0.0.1, not "localhost": inside Alpine "localhost" resolves to the IPv6
  # address first, and the server listens on IPv4 only, so "localhost" is refused.
  TRIES=0
  until wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; do
    TRIES=$((TRIES + 1))
    if [ $TRIES -ge 30 ]; then
      echo "[FORGE] ERROR: Server failed to start for schema creation"
      kill $SERVER_PID 2>/dev/null || true
      exit 1
    fi
    sleep 2
  done

  echo "[FORGE] Schema ready — stopping init server..."
  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
  sleep 1

  # Step 2: Run SDE import
  echo "[FORGE] Running SDE import (downloads ~200 MB, takes 2-5 min)..."
  cd /app && node sde-import.js

  # Mark as done
  touch "$SDE_FLAG"
  echo "[FORGE] SDE import complete."
else
  echo "[FORGE] Database already initialised — skipping SDE import."
fi

echo "[FORGE] Starting server..."
exec node /app/server.js
