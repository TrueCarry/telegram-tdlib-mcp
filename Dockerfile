# syntax=docker/dockerfile:1
#
# Telegram TDLib MCP server - HTTP transport with OAuth, for Coolify or any
# container host. TDLib ships prebuilt (glibc), so the image is Debian-based
# rather than Alpine/musl.

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# gen:schema downloads td_api.tl for the exact TDLib commit that is installed,
# so the catalog always matches the binary. Requires network at build time.
RUN npm run build \
 && npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    TG_HTTP_HOST=0.0.0.0 \
    TG_HTTP_PORT=8787 \
    TDLIB_DB_DIR=/data/tdlib

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The TDLib session (auth keys) lives here. Mount a persistent volume, or every
# redeploy logs the account out.
RUN mkdir -p /data/tdlib && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TG_HTTP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so SIGTERM reaches node and TDLib closes cleanly, releasing its lock.
CMD ["node", "dist/http.js"]
