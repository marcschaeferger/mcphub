#!/bin/bash
# Container entrypoint. Apart from the root-only privilege drop (id, find,
# setpriv) it uses only bash builtins plus npm, so it also runs in minimal
# test environments (see tests/scripts/docker-entrypoint.test.ts).
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

# Started as root (the image default): hand root-owned state to the mcphub
# user, then re-run this script unprivileged. Root is kept only where the
# previous root-only image behaviour is still needed, so existing deployments
# keep working: Docker-in-Docker (full variant), MCPHUB_RUN_AS_ROOT=true, or
# settings the mcphub user cannot write (e.g. a host-owned legacy file mount
# at /app/mcp_settings.json, whose sidecar files are created next to it).
if [ "${EUID}" -eq 0 ] && [ "${MCPHUB_RUN_AS_ROOT:-false}" != "true" ] \
  && ! command -v dockerd >/dev/null 2>&1 && id mcphub >/dev/null 2>&1; then
  run_uid="$(id -u mcphub)"
  run_gid="$(id -g mcphub)"

  # Volumes written by older (root) images and bind-mount directories created
  # by the Docker daemon are root-owned. Only root-owned entries are handed
  # over; files owned by a host user are never touched.
  if [ -d /app/data ]; then
    find /app/data -xdev -user 0 -exec chown "${run_uid}:${run_gid}" {} + 2>/dev/null \
      || warn "could not hand all of /app/data over to uid ${run_uid}"
  fi

  # Every path MCPHub writes on its own: the data directory, the settings
  # file and its sidecars. Existing paths must be writable, missing ones need
  # a writable parent directory.
  # shellcheck disable=SC2016 # expanded by the inner bash, not here
  settings_writable() {
    setpriv --reuid="${run_uid}" --regid="${run_gid}" --clear-groups /bin/bash -c '
      for p in "$@"; do
        if [ -e "$p" ]; then [ -w "$p" ] || exit 1
        else [ -w "${p%/*}" ] || exit 1; fi
      done' check /app/data "${MCPHUB_SETTING_PATH}" \
      "${MCPHUB_SETTING_PATH}.credentials.json" "${MCPHUB_SETTING_PATH}.credentials.key" \
      "${MCPHUB_SETTING_PATH}.approvals.json" "${MCPHUB_SETTING_PATH}.capabilities.json"
  }

  if settings_writable; then
    exec setpriv --reuid="${run_uid}" --regid="${run_gid}" --clear-groups -- "$0" "$@"
  fi
  warn "/app/data or ${MCPHUB_SETTING_PATH} (or a file next to it) is not writable for" \
    "uid ${run_uid}; keeping root for compatibility. Keep the settings in the /app/data" \
    "volume and chown host-owned files to ${run_uid}:${run_gid} to run MCPHub unprivileged."
fi

# Started directly as a non-root user (e.g. --user 10001 or Kubernetes
# runAsUser): nothing can be chowned here, so point at the fix instead.
if [ "${EUID}" -ne 0 ] && [ -d /app/data ] && [ ! -w /app/data ]; then
  warn "/app/data is not writable for uid ${EUID}. Volumes created by images that ran as root" \
    "need 'chown -R ${EUID}:${EUID}' on the host/volume, or start the container without" \
    "--user so the entrypoint can hand them over."
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
