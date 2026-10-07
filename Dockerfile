# syntax=docker/dockerfile:1

# --- App build (Node/pnpm) ---------------------------------------------------
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
 && cp -r apps/web/dist /out/web \
 # Model for the AI bed check (hash-checked), and only this platform's onnxruntime binaries.
 && node apps/server/scripts/fetch-model.mjs /out/models/dinov2-small.onnx \
 && ORT=$(echo /out/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*) \
 && find "$ORT" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find "$ORT/linux" -mindepth 1 -maxdepth 1 ! -name "$(node -p process.arch)" -exec rm -rf {} + \
 && test -f "$ORT/linux/$(node -p process.arch)/onnxruntime_binding.node" \
 # pnpm skips native build scripts; compile better-sqlite3 for this Node/glibc explicitly.
 && cd /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
 && npm run install \
 && test -f build/Release/better_sqlite3.node

# --- OrcaSlicer (extracted from the official AppImage) -------------------------
FROM ubuntu:24.04 AS orca
ARG TARGETARCH
ARG ORCA_VERSION=2.4.2
ARG ORCA_SHA256_AMD64=d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd
ARG ORCA_SHA256_ARM64=e1a07275a25f176626c55a5df39e91bc4476d8c28ee4a3192ff758e29dd5c3ba
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl squashfs-tools python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
# The AppImage can't run in a container (no FUSE), so unpack its squashfs payload directly:
# it starts right after the ELF runtime, at e_shoff + e_shentsize * e_shnum.
RUN case "$TARGETARCH" in \
      arm64) FILE="OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V${ORCA_VERSION}.AppImage"; SUM="$ORCA_SHA256_ARM64" ;; \
      *)     FILE="OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage";         SUM="$ORCA_SHA256_AMD64" ;; \
    esac \
 && curl -fsSL --retry 3 -o orca.AppImage "https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/${FILE}" \
 && echo "${SUM}  orca.AppImage" | sha256sum -c - \
 && OFFSET=$(python3 -c "import struct;d=open('orca.AppImage','rb').read(64);print(struct.unpack_from('<Q',d,0x28)[0]+struct.unpack_from('<H',d,0x3A)[0]*struct.unpack_from('<H',d,0x3C)[0])") \
 && unsquashfs -q -o "$OFFSET" -d /opt/orca orca.AppImage \
 && rm orca.AppImage

# --- Runtime -----------------------------------------------------------------
FROM ubuntu:24.04
ARG APP_VERSION=dev
ARG ORCA_VERSION=2.4.2
LABEL org.opencontainers.image.source="https://github.com/FelixLenz-Code/3dhubprint" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.description="PrintHub: Verwaltung für Klipper/Moonraker-3D-Drucker" \
      org.opencontainers.image.version="$APP_VERSION"
# Libraries OrcaSlicer's CLI links against (it runs headless, no display needed).
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates libgtk-3-0t64 libwebkit2gtk-4.1-0 libgl1 libegl1 libglu1-mesa libosmesa6 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libsecret-1-0 libsm6 libice6 libmspack0t64 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=orca /opt/orca /opt/orca
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    ORCA_VERSION=$ORCA_VERSION \
    ORCA_BIN=/opt/orca/AppRun \
    ORCA_PROFILES=/opt/orca/resources/profiles \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    BEDCHECK_MODEL=/app/models/dinov2-small.onnx \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out ./
# Ubuntu's default user "ubuntu" has uid 1000, matching the data directory created by the installer.
RUN mkdir -p /data && chown ubuntu:ubuntu /data
USER ubuntu
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.mjs"]
