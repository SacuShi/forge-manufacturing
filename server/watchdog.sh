#!/bin/bash
# FORGE Watchdog — health checks + auto-recovery + auto-rollback
# Deployed next to server.js in the app directory (paths below are derived from this file's location).
# Runs every 5 minutes via cron

# Everything is relative to the app directory this script lives in; override with env vars if yours differs.
APP_DIR="${FORGE_APP_DIR:-$(cd "$(dirname "$0")" && pwd)}"
LOG_FILE="$APP_DIR/watchdog.log"
SERVER_JS="$APP_DIR/server.js"
LAST_GOOD_JS="$APP_DIR/server.last-good.js"
FAIL_COUNT_FILE="$APP_DIR/watchdog.fail_count"
PM2_ID=0
LOCAL_PORT=3000
EXTERNAL_URL="${FORGE_EXTERNAL_URL:-https://forge-ukc.com}"
EXTERNAL_HOST="${EXTERNAL_URL#https://}"
TUNNEL_NAME="${FORGE_TUNNEL_NAME:-forge-tunnel}"
ESI_URL="https://esi.evetech.net/latest/status/"
DB_PATH="${FORGE_DB_PATH:-$APP_DIR/../forge-db/forge.db}"
MAX_LOG_LINES=2000
ROLLBACK_AFTER=2  # consecutive end-of-run local failures before rollback

TS=$(date '+%Y-%m-%d %H:%M:%S')
ISSUES=0
FIXED=0
LOCAL_OK=false

log()  { echo "[$TS] $1" >> "$LOG_FILE"; }
ok()   { log "✓ $1"; }
warn() { log "⚠ $1"; ISSUES=$((ISSUES+1)); }
fail() { log "✗ $1"; ISSUES=$((ISSUES+1)); }
fix()  { log "↺ $1"; FIXED=$((FIXED+1)); }

trim_log() {
  [ -f "$LOG_FILE" ] && tail -n $MAX_LOG_LINES "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
}

read_fail_count() {
  [ -f "$FAIL_COUNT_FILE" ] && cat "$FAIL_COUNT_FILE" || echo 0
}

write_fail_count() {
  echo "$1" > "$FAIL_COUNT_FILE"
}

# ── 1. Network interface ─────────────────────────────────────────────────────
NET_IF=$(ip route show default 2>/dev/null | awk '{print $5}' | head -1)
if [ -n "$NET_IF" ]; then
  IF_STATE=$(cat /sys/class/net/$NET_IF/operstate 2>/dev/null)
  if [ "$IF_STATE" != "up" ]; then
    warn "NIC $NET_IF is $IF_STATE — bringing up"
    ip link set "$NET_IF" up && fix "NIC $NET_IF brought up" || fail "NIC $NET_IF could not be brought up"
  fi
fi

# ── 2. DNS resolution ────────────────────────────────────────────────────────
if ! host esi.evetech.net > /dev/null 2>&1; then
  warn "DNS cannot resolve esi.evetech.net — restoring nameservers"
  printf "nameserver 8.8.8.8\nnameserver 8.8.4.4\n" > /etc/resolv.conf
  sleep 2
  if host esi.evetech.net > /dev/null 2>&1; then
    fix "DNS restored (8.8.8.8 / 8.8.4.4)"
  else
    fail "DNS still broken after nameserver restore"
  fi
fi

# ── 3. ESI reachability ──────────────────────────────────────────────────────
ESI_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$ESI_URL")
if [ "$ESI_CODE" != "200" ]; then
  warn "ESI returned HTTP $ESI_CODE (expected 200) — EVE servers may be down"
fi

# ── 4. pm2 process ───────────────────────────────────────────────────────────
PM2_STATUS=$(pm2 jlist 2>/dev/null \
  | python3 -c "
import sys, json
try:
  procs = json.load(sys.stdin)
  p = [x for x in procs if x['pm_id'] == $PM2_ID]
  print(p[0]['pm2_env']['status'] if p else 'missing')
except:
  print('error')
" 2>/dev/null)

if [ "$PM2_STATUS" != "online" ]; then
  warn "pm2 process $PM2_ID is '$PM2_STATUS'"
  pm2 restart $PM2_ID >> "$LOG_FILE" 2>&1
  sleep 6
  PM2_STATUS_AFTER=$(pm2 jlist 2>/dev/null \
    | python3 -c "
import sys, json
try:
  procs = json.load(sys.stdin)
  p = [x for x in procs if x['pm_id'] == $PM2_ID]
  print(p[0]['pm2_env']['status'] if p else 'missing')
except:
  print('error')
" 2>/dev/null)
  if [ "$PM2_STATUS_AFTER" = "online" ]; then
    fix "pm2 process $PM2_ID restarted successfully"
  else
    fail "pm2 process $PM2_ID still not online after restart ($PM2_STATUS_AFTER)"
  fi
fi

# ── 5. Local HTTP response (determines rollback eligibility) ─────────────────
LOCAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://localhost:$LOCAL_PORT")
if [ "$LOCAL_CODE" = "200" ] || [ "$LOCAL_CODE" = "304" ]; then
  LOCAL_OK=true
else
  warn "Local server not responding (HTTP $LOCAL_CODE on port $LOCAL_PORT) — restarting pm2"
  pm2 restart $PM2_ID >> "$LOG_FILE" 2>&1
  sleep 10
  LOCAL_CODE_AFTER=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://localhost:$LOCAL_PORT")
  if [ "$LOCAL_CODE_AFTER" = "200" ] || [ "$LOCAL_CODE_AFTER" = "304" ]; then
    LOCAL_OK=true
    fix "pm2 restarted — local HTTP now OK (HTTP $LOCAL_CODE_AFTER)"
  else
    LOCAL_OK=false
    warn "pm2 restarted but local HTTP still not responding (HTTP $LOCAL_CODE_AFTER)"
  fi
fi

# ── 6. Cloudflared tunnel ────────────────────────────────────────────────────
# Uses the named tunnel (not the systemd service), started as the same user that runs this script
if ! pgrep -f "cloudflared tunnel run $TUNNEL_NAME" > /dev/null 2>&1; then
  warn "cloudflared $TUNNEL_NAME not running — restarting"
  nohup /usr/local/bin/cloudflared tunnel run $TUNNEL_NAME \
    >> "$APP_DIR/cloudflared.log" 2>&1 &
  sleep 8
  if pgrep -f "cloudflared tunnel run $TUNNEL_NAME" > /dev/null 2>&1; then
    fix "cloudflared $TUNNEL_NAME restarted"
  else
    fail "cloudflared $TUNNEL_NAME failed to start — check $APP_DIR/cloudflared.log"
  fi
fi

# ── 7. External URL ──────────────────────────────────────────────────────────
EXT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$EXTERNAL_URL")
if [ "$EXT_CODE" != "200" ] && [ "$EXT_CODE" != "304" ]; then
  warn "External URL $EXTERNAL_URL returned HTTP $EXT_CODE — may be a Cloudflare/tunnel issue"
fi

# ── 8. Disk space ────────────────────────────────────────────────────────────
DISK_PCT=$(df / | tail -1 | awk '{gsub(/%/,"",$5); print $5}')
if   [ "$DISK_PCT" -gt 95 ]; then fail "Disk CRITICAL: ${DISK_PCT}% used on /"
elif [ "$DISK_PCT" -gt 85 ]; then warn "Disk WARNING: ${DISK_PCT}% used on /"; fi

# ── 9. Memory ────────────────────────────────────────────────────────────────
MEM_AVAIL_PCT=$(free | awk '/^Mem:/{printf "%.0f", ($7/$2)*100}')
if   [ "$MEM_AVAIL_PCT" -lt 5  ]; then fail "Memory CRITICAL: ${MEM_AVAIL_PCT}% available"
elif [ "$MEM_AVAIL_PCT" -lt 15 ]; then warn "Memory LOW: ${MEM_AVAIL_PCT}% available"; fi

# ── 10. Database ─────────────────────────────────────────────────────────────
if [ ! -f "$DB_PATH" ]; then
  fail "Database file missing: $DB_PATH"
elif ! sqlite3 "$DB_PATH" "SELECT 1;" > /dev/null 2>&1; then
  fail "Database unreadable: sqlite3 query failed on $DB_PATH"
fi

# ── 11. SSL certificate expiry ───────────────────────────────────────────────
CERT_END=$(echo | timeout 10 openssl s_client -servername "$EXTERNAL_HOST" \
  -connect "$EXTERNAL_HOST:443" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null \
  | cut -d= -f2)
if [ -n "$CERT_END" ]; then
  EXPIRY_EPOCH=$(date -d "$CERT_END" +%s 2>/dev/null)
  DAYS_LEFT=$(( (EXPIRY_EPOCH - $(date +%s)) / 86400 ))
  if   [ "$DAYS_LEFT" -lt 7  ]; then fail "SSL cert CRITICAL: expires in ${DAYS_LEFT}d"
  elif [ "$DAYS_LEFT" -lt 30 ]; then warn "SSL cert expires in ${DAYS_LEFT}d"; fi
fi

# ── 12. Load average ─────────────────────────────────────────────────────────
LOAD1=$(uptime | awk -F'load average:' '{print $2}' | cut -d, -f1 | tr -d ' ')
LOAD_INT=${LOAD1%.*}
CPU_COUNT=$(nproc)
if [ "$LOAD_INT" -gt $((CPU_COUNT * 2)) ] 2>/dev/null; then
  warn "Load average HIGH: $LOAD1 (${CPU_COUNT} CPUs)"
fi

# ── 13. Zombie processes ─────────────────────────────────────────────────────
ZOMBIES=$(ps aux | awk '$8=="Z"' | wc -l)
if [ "$ZOMBIES" -gt 5 ]; then
  warn "High zombie process count: $ZOMBIES"
fi

# ── Rollback / snapshot logic ────────────────────────────────────────────────
FAIL_COUNT=$(read_fail_count)

if [ "$LOCAL_OK" = true ]; then
  # Server healthy — reset fail counter
  if [ "$FAIL_COUNT" -gt 0 ]; then
    write_fail_count 0
    log "↺ Fail counter reset (was $FAIL_COUNT)"
  fi
  # Snapshot server.js only when contents changed (don't snapshot a just-rolled-back file)
  if [ -f "$SERVER_JS" ]; then
    if ! cmp -s "$SERVER_JS" "$LAST_GOOD_JS" 2>/dev/null; then
      cp "$SERVER_JS" "$LAST_GOOD_JS"
      ok "Snapshot updated: server.last-good.js"
    fi
  fi
else
  # Server still not responding after pm2 restart attempt
  NEW_COUNT=$((FAIL_COUNT+1))
  write_fail_count $NEW_COUNT
  warn "Consecutive local failures: $NEW_COUNT/$ROLLBACK_AFTER"

  if [ "$NEW_COUNT" -ge "$ROLLBACK_AFTER" ]; then
    if [ -f "$LAST_GOOD_JS" ]; then
      log "↺ ROLLBACK: restoring server.last-good.js after $NEW_COUNT consecutive failures"
      cp "$LAST_GOOD_JS" "$SERVER_JS"
      pm2 restart $PM2_ID >> "$LOG_FILE" 2>&1
      sleep 10
      ROLLBACK_CHECK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://localhost:$LOCAL_PORT")
      if [ "$ROLLBACK_CHECK" = "200" ] || [ "$ROLLBACK_CHECK" = "304" ]; then
        fix "Rollback successful — server restored from last-good.js (HTTP $ROLLBACK_CHECK)"
        write_fail_count 0
      else
        fail "Rollback attempted but server still not responding (HTTP $ROLLBACK_CHECK) — manual intervention required"
      fi
    else
      fail "Rollback needed but no snapshot exists yet — deploy a working version first"
    fi
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
if [ "$ISSUES" -gt 0 ]; then
  log "── $ISSUES issue(s) found, $FIXED auto-fixed ──"
else
  MINUTE=$(date '+%M')
  if [ "$MINUTE" = "00" ]; then
    ok "All checks passed (hourly heartbeat)"
  fi
fi

trim_log
exit 0
