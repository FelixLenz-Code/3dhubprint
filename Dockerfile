# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build \
 && pnpm --filter @printhub/server deploy --prod /out \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/web/dist /out/web \
 # pnpm skips native build scripts; compile better-sqlite3 for this Node/glibc explicitly.
 && cd /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
 && npm run install \
 && test -f build/Release/better_sqlite3.node

FROM node:22-bookworm-slim
ARG APP_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/FelixLenz-Code/3dhubprint" \
      org.opencontainers.image.description="PrintHub: Verwaltung für Klipper/Moonraker-3D-Drucker" \
      org.opencontainers.image.version="$APP_VERSION"
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
