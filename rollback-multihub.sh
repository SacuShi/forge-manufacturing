#!/bin/bash
# Rollback: restore pre-multi-hub state for both backend and frontend
set -e

echo "↩ Restoring backend..."
cp server/server.js.pre-multihub server/server.js

echo "↩ Restoring frontend source files..."
cp forge-v1/src/components/TradingTab.tsx.pre-multihub  forge-v1/src/components/TradingTab.tsx
cp forge-v1/src/types/index.ts.pre-multihub             forge-v1/src/types/index.ts
cp forge-v1/src/hooks/useTradingBook.ts.pre-multihub    forge-v1/src/hooks/useTradingBook.ts
cp forge-v1/src/styles/components.css.pre-multihub      forge-v1/src/styles/components.css

echo "⟳ Rebuilding frontend..."
cd forge-v1 && npm run build && cd ..

echo "⬆ Deploying..."
scp server/server.js gumpy54@192.168.1.62:/home/gumpy54/forge-server/server.js
scp -r forge-v1/dist/* gumpy54@192.168.1.62:/home/gumpy54/forge-server/public/
ssh gumpy54@192.168.1.62 "pm2 restart 0"

echo "✓ Rolled back to single-hub (Jita) state"
