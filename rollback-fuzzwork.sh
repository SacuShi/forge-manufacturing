#!/bin/bash
# Rollback: swap Fuzzwork book poller back to ESI and restart
set -e
cp server/server.js.pre-fuzzwork server/server.js
scp server/server.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/server.js
ssh gumpy54@192.168.1.62 "pm2 restart 0"
echo "✓ Rolled back to ESI book poller"
