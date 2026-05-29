# ─────────────────────────────────────────────────────────────────────────────
# F.O.R.G.E. — Multi-stage Docker build
#
# Stage 1: Build the React frontend
# Stage 2: Production Node server with compiled sqlite3
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Frontend build ───────────────────────────────────────────────────
FROM node:22-alpine AS frontend-build

WORKDIR /build

# Copy frontend source
COPY forge-v1/package*.json ./
RUN npm ci

COPY forge-v1/ ./
RUN npm run build
# Output: /build/dist/


# ── Stage 2: Production server ────────────────────────────────────────────────
FROM node:22-alpine AS production

# sqlite3 native module + sde-import needs: build tools, python3, curl, tar, xz
RUN apk add --no-cache \
    build-base \
    python3 \
    curl \
    tar \
    xz

WORKDIR /app

# Copy server files
COPY server/package*.json ./
RUN npm install --production

COPY server/server.js        ./server.js
COPY server/forge-security.js ./forge-security.js
COPY server/sde-import.js    ./sde-import.js

# Copy built frontend into public/
COPY --from=frontend-build /build/dist/ ./public/

# Copy entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Database lives outside the image (mounted volume)
# DB_PATH in server.js = path.join(__dirname, '../forge-db/forge.db') = /forge-db/forge.db
VOLUME ["/forge-db"]

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
