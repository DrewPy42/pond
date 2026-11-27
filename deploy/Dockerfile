# The production image (docs/ship-design.md, M9a). Dockerfile.dev is the development one.
#
#   docker build -f deploy/Dockerfile -t pond .
#
# It serves plain HTTP on port 3210, meant to be reached only through Caddy.

# Node, fixed to one exact multi-architecture image. To update, take the new digest from
# `docker buildx imagetools inspect node:26-bookworm-slim`.
ARG NODE_IMAGE=node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9

# This stage is the same as in Dockerfile.dev; a test keeps the two alike.
# rclone, for backups to online storage (docs/backup-design.md). The version and the SHA-256 of
# each download are fixed here, so a different file fails the build. To update: change all three
# and recheck the accepted settings in apps/server/src/backup/remote/setup.ts.
FROM ${NODE_IMAGE} AS rclone
ARG RCLONE_VERSION=1.76.0
ARG RCLONE_SHA256_AMD64=b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7
ARG RCLONE_SHA256_ARM64=ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip
RUN set -eu; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) sum="$RCLONE_SHA256_AMD64" ;; \
    arm64) sum="$RCLONE_SHA256_ARM64" ;; \
    *) echo "No rclone checksum for $arch" >&2; exit 1 ;; \
  esac; \
  name="rclone-v${RCLONE_VERSION}-linux-${arch}"; \
  curl -sSfL -o /tmp/rclone.zip "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/${name}.zip"; \
  echo "$sum  /tmp/rclone.zip" | sha256sum -c -; \
  unzip -q -j /tmp/rclone.zip "${name}/rclone" -d /out

# pnpm and the list of what to install, shared by the two installs below.
FROM ${NODE_IMAGE} AS tools
# pnpm sets itself up with an install script; npm asks for that to be named.
RUN npm install -g --allow-scripts=pnpm pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY lilypads/template/package.json lilypads/template/
COPY lilypads/personal/package.json lilypads/personal/
COPY lilypads/business/package.json lilypads/business/
# Files arrive with the permissions they have in the folder being built, and Pond runs as a user
# who doesn't own them. So each stage that copies files in makes them readable by everyone.
RUN chmod -R a+rX .

# Builds the web app. Only the built files leave this stage.
FROM tools AS web
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @pond/web build && chmod -R a+rX apps/web/dist

# What the server needs to run, and nothing used only for development.
FROM tools AS deps
RUN pnpm install --frozen-lockfile --prod --filter "@pond/server..."

# The server's source (run with tsx) without its tests.
FROM ${NODE_IMAGE} AS source
WORKDIR /src
COPY tsconfig.base.json ./
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/sdk/tsconfig.json packages/sdk/LICENSE packages/sdk/
COPY packages/sdk/src packages/sdk/src
COPY lilypads/template/tsconfig.json lilypads/template/lilypad.json lilypads/template/LICENSE lilypads/template/
COPY lilypads/template/src lilypads/template/src
COPY lilypads/personal/tsconfig.json lilypads/personal/lilypad.json lilypads/personal/
COPY lilypads/personal/src lilypads/personal/src
COPY lilypads/business/tsconfig.json lilypads/business/lilypad.json lilypads/business/
COPY lilypads/business/src lilypads/business/src
RUN find . -name '*.test.ts' -delete && rm -rf apps/server/src/testing && chmod -R a+rX .

FROM ${NODE_IMAGE}
# rclone checks servers against the system's certificate list, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rclone /out/rclone /usr/local/bin/rclone
WORKDIR /app
# Everything here belongs to root, so the user Pond runs as can't change it.
COPY --from=deps /app ./
COPY --from=source /src ./
COPY --from=web /app/apps/web/dist apps/web/dist
COPY --chmod=755 deploy/pond /usr/local/bin/pond
# The folders Pond may write to. A new Docker volume mounted on one takes this ownership.
RUN install -d -o node -g node -m 700 /data /backups
ENV NODE_ENV=production \
  POND_DATA_DIR=/data \
  POND_WEB_DIR=/app/apps/web/dist \
  POND_RCLONE_PATH=/usr/local/bin/rclone
# POND_BACKUP_DIR is deliberately unset: it is set where /backups is mounted, so backups can't
# land inside a container and disappear with it.
# User 1000 ("node"), not root.
USER 1000:1000
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node itself is the first process, so it receives Docker's stop signal and shuts down cleanly.
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
