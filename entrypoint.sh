#!/bin/bash
# Container entrypoint. It never changes file owners or users: the image runs
# as uid 10001 by default, and volumes from older (root) images are handed
# over once with the separate mcphub-migrate command. It uses only bash
# builtins plus npm, so it also runs in minimal test environments (see
# tests/scripts/docker-entrypoint.test.ts).
set -eu

warn() {
  echo "WARNING: $*" >&2
}

# The one-shot migration runs before any check below: it is the fix those
# checks point to, and it needs root, which the checks would warn about.
case "${1:-}" in
  mcphub-migrate | */mcphub-migrate) exec "$@" ;;
esac

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

# Same rule as the application (src/utils/systemConfigCache.ts).
database_mode() {
  if [ -n "${USE_DB:-}" ]; then [ "$USE_DB" = "true" ]; else [ -n "${DB_URL:-}" ]; fi
}

if [ "${EUID}" -ne 0 ]; then
  # Every path MCPHub writes on its own: the data directory and, in file mode,
  # the settings file and its sidecars. Existing paths must be writable,
  # missing ones need a writable parent directory. In database mode the
  # settings file is only read (it may be a read-only ConfigMap).
  paths=(/app/data)
  if ! database_mode; then
    paths+=("${MCPHUB_SETTING_PATH}" "${MCPHUB_SETTING_PATH}.credentials.json"
      "${MCPHUB_SETTING_PATH}.credentials.key" "${MCPHUB_SETTING_PATH}.approvals.json"
      "${MCPHUB_SETTING_PATH}.capabilities.json")
  fi
  denied=()
  for p in "${paths[@]}"; do
    if [ -e "$p" ]; then
      [ -w "$p" ] || denied+=("$p")
      continue
    fi
    # Missing: it is created in the nearest existing parent directory.
    dir="${p%/*}"
    while [ -n "$dir" ] && [ ! -e "$dir" ]; do dir="${dir%/*}"; done
    dir="${dir:-/}"
    [ -w "$dir" ] && continue
    case " ${denied[*]-} " in *" ${dir} "*) ;; *) denied+=("${dir} (to create ${p#"${dir%/}"/})") ;; esac
  done
  if [ "${#denied[@]}" -gt 0 ]; then
    {
      echo "ERROR: MCPHub runs as uid ${EUID} and cannot write: ${denied[*]}"
      echo "Volumes written by older MCPHub images (which ran as root) are root-owned."
      echo "Hand them to uid 10001 once, as root, with mcphub-migrate, then start MCPHub again:"
      echo "  docker run:  docker run --rm --user 0:0 -v <volume>:/app/data <image> mcphub-migrate"
      echo "  compose:     docker compose run --rm --user 0:0 <service> mcphub-migrate"
      echo "  Kubernetes:  set the pod securityContext fsGroup: 10001 and fsGroupChangePolicy: OnRootMismatch"
      echo "A host directory owned by a host user (for example ./data) is not changed by mcphub-migrate;"
      echo "hand it to uid 10001 on the host instead:  sudo chown -R 10001:10001 ./data"
      echo "Add --dry-run to mcphub-migrate to list the changes first. A settings file mounted at"
      echo "/app/mcp_settings.json has to move into /app/data; mcphub-migrate explains how."
    } >&2
    exit 1
  fi
elif ! command -v dockerd >/dev/null 2>&1 && [ "${MCPHUB_RUN_AS_ROOT:-false}" != "true" ]; then
  # Root outside the full (Docker-in-Docker) variant: still works, but only
  # because something (user: 0, --user 0:0, runAsUser: 0) asked for it.
  warn "MCPHub runs as root. The image runs as uid 10001 by default: remove 'user: 0'" \
    "(--user 0:0, runAsUser: 0) and hand the data over once with mcphub-migrate" \
    "(see docs/configuration/docker-setup.mdx, 'Upgrading from root images')." \
    "Set MCPHUB_RUN_AS_ROOT=true to keep root deliberately and silence this warning."
fi

if [ "${EUID}" -ne 0 ] && [ "${MCPHUB_RUN_AS_ROOT:-false}" = "true" ]; then
  warn "MCPHUB_RUN_AS_ROOT=true no longer switches to root; the container runs as uid ${EUID}." \
    "Start it with --user 0:0 (compose: user: \"0:0\") if root is really needed."
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
