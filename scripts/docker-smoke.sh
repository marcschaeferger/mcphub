#!/usr/bin/env bash
# Container smoke test for an MCPHub image.
#
#   scripts/docker-smoke.sh <image-ref>
#
# Starts the image with a random admin password and checks that
#   1. the container becomes healthy (HEALTHCHECK),
#   2. MCPHub runs as uid 10001,
#   3. the admin login works,
#   4. a stdio server started with uvx and one started with npx connect,
#   5. a tool call is answered end to end,
#   6. the image ships no pip (nor a pip wheel) and `uv venv` still works,
#   7. a root-owned data volume (from an older root image) stops the start
#      with an ERROR, and `mcphub-migrate` run as root fixes it.
# Needs docker, curl and jq on the host. The credentials are random per run,
# are never printed; the container and the test volume are removed on exit.
#
# Exit codes: 0 all checks passed, 1 a check failed, 2 usage or missing tool.
set -euo pipefail

# Pinned so a new upstream release cannot break the smoke test unnoticed.
UVX_PACKAGE="mcp-server-fetch==2026.11.11"
NPX_PACKAGE="@modelcontextprotocol/server-everything@2.3.0"
EXPECTED_UID=10001
HEALTHY_TIMEOUT=${SMOKE_HEALTHY_TIMEOUT:-180}
CONNECT_TIMEOUT=${SMOKE_CONNECT_TIMEOUT:-240}

die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <image-ref>" >&2
  exit 2
fi
IMAGE=$1
for tool in docker curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 2; }
done

WORKDIR=$(mktemp -d)
chmod 700 "$WORKDIR"
CONTAINER="mcphub-smoke-$$-$RANDOM"
VOLUME="${CONTAINER}-data"

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && docker inspect "$CONTAINER" >/dev/null 2>&1; then
    # Diagnostics for a failed run. The generated password is only logged when
    # ADMIN_PASSWORD is unset, so the filter is a safety net, not the control.
    echo "--- last container log lines ---" >&2
    docker logs --tail 30 "$CONTAINER" 2>&1 \
      | sed -E 's/(password|token)[^ ]*[: =]+[^ ]+/\1 ***/Ig' >&2 || true
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Random credentials, handed to the container through the environment so they
# never appear on a command line.
ADMIN_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
export ADMIN_PASSWORD
MARKER="smoke-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"

docker run -d --name "$CONTAINER" -e ADMIN_PASSWORD -p 127.0.0.1::3000 "$IMAGE" >/dev/null \
  || die "could not start $IMAGE"
PORT=$(docker port "$CONTAINER" 3000/tcp | head -n1 | sed 's/.*://')
[ -n "$PORT" ] || die "no published port for the container"
BASE="http://127.0.0.1:${PORT}"

# 1. healthy
status=none
for ((i = 0; i < HEALTHY_TIMEOUT; i += 2)); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")
  [ "$status" = "healthy" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true" ] || die "container exited early"
  sleep 2
done
[ "$status" = "healthy" ] || die "container not healthy after ${HEALTHY_TIMEOUT}s (status: $status)"
ok "container healthy"

# 2. runs as the unprivileged uid (the image's default user, no switch at runtime)
uid=$(docker exec "$CONTAINER" ps -eo uid=,args= | awk '$2 == "node" && $3 == "dist/index.js" {print $1; exit}')
[ "$uid" = "$EXPECTED_UID" ] || die "MCPHub runs as uid '${uid:-unknown}', expected $EXPECTED_UID"
ok "MCPHub runs as uid $uid"

# 3. login. Password via stdin, token into a 0600 header file: neither shows up
# in the process list or the output.
login=$(jq -nc --arg p "$ADMIN_PASSWORD" '{username:"admin",password:$p}' \
  | curl -fsS -H 'content-type: application/json' -d @- "$BASE/api/auth/login") \
  || die "login request failed"
token=$(printf '%s' "$login" | jq -r '.token // empty')
[ -n "$token" ] || die "login returned no token"
umask 077
printf 'x-auth-token: %s\nAuthorization: Bearer %s\n' "$token" "$token" > "$WORKDIR/headers"
unset ADMIN_PASSWORD token login
ok "login"

api() { # api METHOD PATH [JSON-BODY]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H "@$WORKDIR/headers" -H 'content-type: application/json' -d "$body" "$BASE$path"
  else
    curl -fsS -X "$method" -H "@$WORKDIR/headers" "$BASE$path"
  fi
}

# 4. one uvx and one npx stdio server
add_server() { # add_server NAME COMMAND ARG...
  local name=$1 cmd=$2
  shift 2
  local body args
  args=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  body=$(jq -nc --arg n "$name" --arg c "$cmd" --argjson a "$args" '{name:$n,config:{type:"stdio",command:$c,args:$a}}')
  api POST /api/servers "$body" | jq -e '.success == true' >/dev/null || die "could not add server $name"
}
add_server smoke-uvx uvx "$UVX_PACKAGE"
add_server smoke-npx npx -y "$NPX_PACKAGE"

states=""
for ((i = 0; i < CONNECT_TIMEOUT; i += 3)); do
  states=$(api GET /api/servers | jq -r '[.data[] | select(.name | startswith("smoke-")) | .status] | sort | join(",")')
  [ "$states" = "connected,connected" ] && break
  sleep 3
done
[ "$states" = "connected,connected" ] || die "stdio servers not connected after ${CONNECT_TIMEOUT}s (states: ${states:-none})"
ok "uvx server ($UVX_PACKAGE) and npx server ($NPX_PACKAGE) connected"

# 5. tool call answered by the npx server
reply=$(api POST /api/tools/smoke-npx/echo "$(jq -nc --arg m "$MARKER" '{message:$m}')") \
  || die "tool call request failed"
printf '%s' "$reply" | grep -q "$MARKER" || die "tool call did not echo the marker"
ok "tool call answered"

# 6. no pip: no pip/pip3 command, no pip module, no wheel ensurepip could
# reinstall it from, and uv creates a venv without it (as the runtime uid).
docker exec "$CONTAINER" sh -c '! command -v pip && ! command -v pip3 && ! python3 -m pip --version' \
  >/dev/null 2>&1 || die "pip is installed in the image"
wheels=$(docker exec "$CONTAINER" python3 -c \
  'import glob, sysconfig; print(" ".join(glob.glob(sysconfig.get_paths()["stdlib"] + "/ensurepip/_bundled/pip-*.whl") + glob.glob("/usr/share/python-wheels/pip-*.whl")))') \
  || die "could not look for pip wheels"
[ -z "$wheels" ] || die "pip wheel left in the image: $wheels"
docker exec -u "$EXPECTED_UID" "$CONTAINER" uv venv --quiet /tmp/smoke-venv >/dev/null 2>&1 \
  || die "uv venv failed"
ok "no pip in the image, uv venv works"

# 7. upgrade from a root image: a volume whose files belong to root must stop
# the start with the ERROR, and mcphub-migrate (as root) must hand it over.
# `true` as the command runs only the entrypoint's checks, not MCPHub.
docker volume create "$VOLUME" >/dev/null || die "could not create a test volume"
docker run --rm --user 0:0 --entrypoint sh -v "$VOLUME:/app/data" "$IMAGE" \
  -c 'echo "{}" > /app/data/mcp_settings.json && chown -R 0:0 /app/data' \
  || die "could not prepare a root-owned volume"
if out=$(docker run --rm -v "$VOLUME:/app/data" "$IMAGE" true 2>&1); then
  die "start on a root-owned volume did not fail"
fi
printf '%s' "$out" | grep -q 'ERROR: MCPHub runs as uid' || die "start on a root-owned volume failed without the ERROR"
docker run --rm --user 0:0 -v "$VOLUME:/app/data" "$IMAGE" mcphub-migrate >/dev/null \
  || die "mcphub-migrate failed"
docker run --rm -v "$VOLUME:/app/data" "$IMAGE" true >/dev/null 2>&1 \
  || die "start still fails after mcphub-migrate"
ok "root-owned volume refused, mcphub-migrate hands it over"

echo "PASS: $IMAGE"
