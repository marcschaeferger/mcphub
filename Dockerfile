# syntax=docker/dockerfile:1.7

# Base images are pinned by tag and digest so a rebuild cannot silently pick
# up a different upstream image. Bump tag and digest together, e.g. with
#   docker buildx imagetools inspect node:22.23.4-trixie-slim
ARG NODE_IMAGE=node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6
ARG PYTHON_IMAGE=python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490

FROM ${UV_IMAGE} AS uv
FROM ${NODE_IMAGE} AS node

# Node.js for the runtime image. The npm bundled with Node 22 ships
# dependencies with known HIGH advisories (pacote, sigstore, brace-expansion),
# so npm/npx (used to launch stdio MCP servers) is replaced by a pinned npm 11.
FROM node AS node-runtime
ARG NPM_VERSION=11.21.2
RUN npm install -g "npm@${NPM_VERSION}" \
  && npm cache clean --force \
  && rm -rf /root/.npm

# ---------------------------------------------------------------------------
# build: full dependency tree (incl. devDependencies) to compile backend and
# frontend. Nothing from this stage except build output reaches the runtime.
# ---------------------------------------------------------------------------
FROM node AS build
WORKDIR /src
# pnpm is resolved by Corepack from package.json "packageManager", which pins
# the version together with its sha256.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY . .
# The bundled servers.json is the default. Refreshing it from mcpm.sh pulls an
# unverified remote file into the image, so it is opt-in.
ARG FETCH_LATEST_SERVERS=false
RUN if [ "$FETCH_LATEST_SERVERS" = "true" ]; then \
  node -e "fetch('https://mcpm.sh/api/servers.json',{signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const t=await r.text();JSON.parse(t);require('fs').writeFileSync('servers.json',t)}).catch(e=>console.error('Failed to download servers.json, using bundled version:',e.message))"; \
  fi \
  && pnpm build

# ---------------------------------------------------------------------------
# prod-deps: production dependencies only (patches applied by pnpm).
# ---------------------------------------------------------------------------
FROM node AS prod-deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile --store-dir /pnpm/store

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

ARG VERSION=dev
LABEL org.opencontainers.image.title="MCPHub" \
  org.opencontainers.image.description="Self-hosted MCP gateway and control plane" \
  org.opencontainers.image.source="https://github.com/samanhappy/mcphub" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="${VERSION}"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime tools only: git (uvx/npx git+ sources), procps (`ps` for tree-kill,
# issue #1072), tini (reaps the stdio server processes), curl (kept for
# existing user healthchecks). No compiler toolchain. Versions are not pinned
# on purpose: the digest-pinned base plus a fresh apt index picks up Debian
# security updates on every rebuild (also for packages already in the base).
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps tini \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

# Node.js from the official image of the same release instead of a piped
# NodeSource setup script.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
  && corepack enable pnpm \
  && node --version && npm --version && npx --version

ARG MCPHUB_UID=10001
ARG MCPHUB_GID=10001
RUN groupadd --gid "${MCPHUB_GID}" mcphub \
  && useradd --uid "${MCPHUB_UID}" --gid mcphub --create-home --home-dir /home/mcphub \
    --shell /bin/bash mcphub

ENV HOME=/home/mcphub \
  PATH=/home/mcphub/.local/bin:/usr/local/cargo/bin:$PATH \
  RUSTUP_HOME=/usr/local/rustup \
  CARGO_HOME=/usr/local/cargo \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Optional "full" variant: browsers for Playwright, a Rust toolchain and a
# Docker engine (docker-in-docker needs the container to run as root and
# privileged). Every download is checksum- or fingerprint-verified.
ARG INSTALL_EXT=false
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
ARG DOCKER_GPG_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# hadolint ignore=DL3008,DL3016
RUN if [ "$INSTALL_EXT" = "true" ]; then \
  export HOME=/root; \
  ARCH="$(uname -m)"; \
  if [ "$ARCH" = "x86_64" ]; then \
  npx -y playwright install --with-deps chrome firefox; \
  else \
  echo "Skipping Chrome and Firefox installation on non-amd64 architecture: $ARCH"; \
  fi; \
  apt-get update && \
  apt-get install -y --no-install-recommends gnupg iptables pigz xz-utils && \
  case "$ARCH" in \
  x86_64) RUST_TARGET=x86_64-unknown-linux-gnu; RUSTUP_SHA256="$RUSTUP_SHA256_AMD64" ;; \
  aarch64) RUST_TARGET=aarch64-unknown-linux-gnu; RUSTUP_SHA256="$RUSTUP_SHA256_ARM64" ;; \
  *) echo "Unsupported architecture for rustup: $ARCH" >&2; exit 1 ;; \
  esac && \
  curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init \
    "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUST_TARGET}/rustup-init" && \
  echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - && \
  chmod +x /tmp/rustup-init && \
  /tmp/rustup-init -y --no-modify-path --profile minimal && \
  rm -f /tmp/rustup-init && \
  cargo --version && rustc --version && \
  install -m 0755 -d /etc/apt/keyrings && \
  curl -fsSLo /etc/apt/keyrings/docker.asc https://download.docker.com/linux/debian/gpg && \
  gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc \
    | grep -q "^fpr:::::::::${DOCKER_GPG_FINGERPRINT}:" && \
  chmod a+r /etc/apt/keyrings/docker.asc && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io && \
  apt-get purge -y --auto-remove gnupg && \
  apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/*; \
  fi

WORKDIR /app

COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/frontend/dist ./frontend/dist
COPY --from=build /src/servers.json ./servers.json
COPY package.json ./
COPY bin ./bin
COPY locales ./locales
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

# The application code stays root-owned and read-only for the runtime user;
# only the data directory and HOME (npx/uvx caches, ~/.npmrc) are writable.
RUN install -d -o mcphub -g mcphub -m 0750 /app/data

# Pre-install the fetch server for the runtime user, into its HOME, so the
# cache management in MCPHub can still refresh or remove it.
USER ${MCPHUB_UID}:${MCPHUB_GID}
RUN uv tool install --no-cache mcp-server-fetch

# The container starts as root only so the entrypoint can hand root-owned
# state (volumes from older images, daemon-created bind mounts) to the mcphub
# user; it then runs MCPHub as uid ${MCPHUB_UID} via setpriv. It stays root
# only for Docker-in-Docker (full variant), MCPHUB_RUN_AS_ROOT=true or
# settings the mcphub user cannot write (see entrypoint.sh).
# Strictly non-root platforms can run it with --user 10001:10001 /
# runAsUser: 10001, or build it with --build-arg RUN_AS=10001:10001.
ARG RUN_AS=0:0
USER ${RUN_AS}

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
# Launch node directly instead of `pnpm start`: the pnpm shim resolves via
# Corepack, which re-downloads pnpm into the runtime user's HOME cache when the
# image runs as a non-root user, breaking startup in egress-restricted
# environments (#1105).
CMD ["node", "dist/index.js"]
