#!/bin/bash
# Container entrypoint. Uses only bash builtins plus npm so it also runs in
# minimal test environments (see tests/scripts/docker-entrypoint.test.ts).
set -eu

warn() {
  echo "WARNING: $*" >&2
}

# Hide "user:password@" in proxy/registry URLs before logging them.
mask_url() {
  local url="$1"
  if [[ "$url" =~ ^([^:/]+://)[^/]*@(.*)$ ]]; then
    printf '%s***@%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$url"
  fi
}

# Write an npm setting to ~/.npmrc; a read-only HOME must not stop startup.
npm_config_set() {
  if ! npm config set "$1" "$2" >/dev/null 2>&1; then
    warn "could not set npm config '$1' (is HOME=${HOME:-unset} writable?); continuing without it"
  fi
}

# Explicit overrides win; preserve legacy file mounts before using the data directory.
if [ -z "${MCPHUB_SETTING_PATH:-}" ]; then
  if [ -f /app/mcp_settings.json ]; then
    export MCPHUB_SETTING_PATH=/app/mcp_settings.json
  else
    export MCPHUB_SETTING_PATH=/app/data/mcp_settings.json
  fi
fi

# The image runs as an unprivileged user by default. Volumes created by older
# (root) images stay root-owned; say so instead of chowning them silently.
if [ -d /app/data ] && [ ! -w /app/data ]; then
  warn "/app/data is not writable for uid ${EUID}. Volumes created by images that ran as root" \
    "need 'chown -R ${EUID}:${EUID}' on the host/volume, or run the container with 'user: root'" \
    "(docker run --user root)."
fi

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
echo "Setting npm registry to $(mask_url "$NPM_REGISTRY")"
npm_config_set registry "$NPM_REGISTRY"

# Handle HTTP_PROXY and HTTPS_PROXY environment variables
if [ -n "${HTTP_PROXY:-}" ]; then
  echo "Setting HTTP proxy to $(mask_url "$HTTP_PROXY")"
  npm_config_set proxy "$HTTP_PROXY"
  export HTTP_PROXY
fi

if [ -n "${HTTPS_PROXY:-}" ]; then
  echo "Setting HTTPS proxy to $(mask_url "$HTTPS_PROXY")"
  npm_config_set https-proxy "$HTTPS_PROXY"
  export HTTPS_PROXY
fi

echo "Using REQUEST_TIMEOUT: ${REQUEST_TIMEOUT:-default}"

# Auto-start the Docker daemon (full variant). dockerd needs root, so it is
# only started when the container runs as root.
if command -v dockerd >/dev/null 2>&1; then
  if [ "${EUID}" -ne 0 ]; then
    warn "dockerd is installed but the container runs as uid ${EUID}; not starting it." \
      "Run as root (and privileged) to use Docker-in-Docker."
  else
    echo "Docker daemon detected, starting dockerd..."
    mkdir -p /var/lib/docker
    dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs >/var/log/dockerd.log 2>&1 &

    echo "Waiting for Docker daemon to be ready..."
    TIMEOUT=15
    ELAPSED=0
    while ! docker info >/dev/null 2>&1; do
      if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
        warn "Docker daemon failed to start within ${TIMEOUT} seconds; check /var/log/dockerd.log"
        break
      fi
      sleep 1
      ELAPSED=$((ELAPSED + 1))
    done

    if docker info >/dev/null 2>&1; then
      echo "Docker daemon started successfully"
    fi
  fi
fi

exec "$@"
