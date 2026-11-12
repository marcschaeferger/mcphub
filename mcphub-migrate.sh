#!/bin/bash
# mcphub-migrate: one-shot handover of data written by MCPHub images that ran
# as root to the unprivileged mcphub user (uid/gid 10001).
#
#   mcphub-migrate [--dry-run] [--include-mounts]
#
# Run it once, as root, with the same volumes as the MCPHub service:
#   docker run --rm --user 0:0 -v <volume>:/app/data <image> mcphub-migrate
#   docker compose run --rm --user 0:0 <service> mcphub-migrate
#
# What it changes: every entry owned by uid 0 in the /app/data mount and in
# every directory mount at or below /home/mcphub (the npm/uv caches) is
# chowned to 10001:10001. Symlinks are changed themselves, never followed
# (find -P, chown -h). Every other mount point is a boundary: a separate mount
# below /app/data (a host directory, a docker.sock, a single file) is only
# reported, unless --include-mounts is given, and a mounted single file is
# never changed. Entries owned by any other uid (a host user) are never
# touched. A settings file bind-mounted at /app/mcp_settings.json is only
# read: it is copied to /app/data when no settings file exists there yet.
# Running it again changes nothing.
#
# Exit codes: 0 done (or nothing to do), 1 not root or a change failed,
# 2 usage.
set -euo pipefail

DATA_DIR=/app/data
LEGACY_SETTINGS=/app/mcp_settings.json
MCPHUB_HOME=/home/mcphub
MOUNTINFO=/proc/self/mountinfo
SIDECARS=(.credentials.json .credentials.key .approvals.json .capabilities.json)

usage() {
  cat <<'EOF'
usage: mcphub-migrate [--dry-run] [--include-mounts]
Hands root-owned files under /app/data (and mounts below /home/mcphub) to the
mcphub user, uid/gid 10001. Run it once, as root, with the service's volumes:
  docker run --rm --user 0:0 -v <volume>:/app/data <image> mcphub-migrate
  docker compose run --rm --user 0:0 <service> mcphub-migrate
  --dry-run, -n     list what would change, change nothing
  --include-mounts  also hand over directories mounted separately below
                    /app/data (mounted single files are never changed)
EOF
}

dry_run=false
include_mounts=false
for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) dry_run=true ;;
    --include-mounts) include_mounts=true ;;
    --help | -h) usage; exit 0 ;;
    *) echo "mcphub-migrate: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "${EUID}" -ne 0 ]; then
  cat >&2 <<EOF
mcphub-migrate must run as root to change file owners (it runs as uid ${EUID}).
Run it once with the volumes of the MCPHub service:
  docker run --rm --user 0:0 -v <volume>:/app/data <image> mcphub-migrate
  docker compose run --rm --user 0:0 <service> mcphub-migrate
On Kubernetes no migration run is needed: set the pod securityContext
fsGroup: 10001 and fsGroupChangePolicy: OnRootMismatch.
EOF
  exit 1
fi

target_uid="$(id -u mcphub 2>/dev/null || echo 10001)"
target_gid="$(id -g mcphub 2>/dev/null || echo 10001)"
owner="${target_uid}:${target_gid}"
verb="handed"
if $dry_run; then verb="would hand"; fi

# Mount points from /proc/self/mountinfo (field 5, with spaces etc. as octal
# escapes such as \040). Bind mounts from the same host filesystem share its
# device number, so find -xdev is no boundary for them: every mount point
# below a scanned directory is pruned explicitly and handled on its own.
mounts=()
if [ -r "$MOUNTINFO" ]; then
  while read -r _ _ _ _ mnt _; do
    printf -v mnt '%b' "$mnt"
    case "$mnt" in
      "$DATA_DIR"/* | "$MCPHUB_HOME" | "$MCPHUB_HOME"/*)
        case " ${mounts[*]-} " in *" ${mnt} "*) ;; *) mounts+=("$mnt") ;; esac ;;
    esac
  done <"$MOUNTINFO"
fi

# Directories to scan: the data directory, every directory mount at or below
# HOME (the rest of HOME is part of the image and already owned by the mcphub
# user) and, with --include-mounts, directory mounts below the data directory.
roots=()
[ -d "$DATA_DIR" ] && roots+=("$DATA_DIR")
for mnt in "${mounts[@]}"; do
  if [ ! -d "$mnt" ] || [ -L "$mnt" ]; then
    echo "${mnt}: a single file is mounted here; it is not changed"
    continue
  fi
  case "$mnt" in
    "$DATA_DIR"/*)
      if ! $include_mounts; then
        echo "${mnt}: a separate mount; it is not changed (add --include-mounts to hand it over too)"
        continue
      fi ;;
  esac
  roots+=("$mnt")
done

# find ROOT, without the mount points below it (they are separate roots or
# deliberately left alone), with the given tests.
scan() {
  local root=$1 mnt
  shift
  local prune=()
  for mnt in "${mounts[@]}"; do
    case "$mnt" in
      "$root"/*)
        [ "${#prune[@]}" -gt 0 ] && prune+=(-o)
        prune+=(-path "$mnt") ;;
    esac
  done
  if [ "${#prune[@]}" -gt 0 ]; then
    find "$root" -xdev \( "${prune[@]}" \) -prune -o "$@"
  else
    find "$root" -xdev "$@"
  fi
}

changed=0
foreign=0
failed=0
for root in "${roots[@]}"; do
  count=0
  while IFS= read -r -d '' entry; do
    $dry_run && echo "would chown ${owner}: ${entry}"
    count=$((count + 1))
  done < <(scan "$root" -user 0 -print0)
  if [ "$count" -gt 0 ] && ! $dry_run; then
    scan "$root" -user 0 -exec chown -h "$owner" {} + || failed=1
  fi
  others=0
  while IFS= read -r -d '' _; do others=$((others + 1)); done \
    < <(scan "$root" ! -user 0 ! -user "$target_uid" -print0)
  echo "${root}: ${verb} ${count} root-owned entries to ${owner}; left ${others} entries of other owners unchanged"
  changed=$((changed + count))
  foreign=$((foreign + others))
done
[ "${#roots[@]}" -gt 0 ] || echo "nothing mounted at ${DATA_DIR} or ${MCPHUB_HOME}: no owners to change"

# Legacy file mount. The host owns that file, so it is never changed here; the
# unprivileged process cannot create the sidecar files next to it in /app, so
# it has to live in the data directory from now on.
copied=0
if [ -e "$LEGACY_SETTINGS" ]; then
  dest="${DATA_DIR}/mcp_settings.json"
  echo "A settings file is mounted at ${LEGACY_SETTINGS}. mcphub-migrate does not change it."
  if [ ! -d "$DATA_DIR" ]; then
    echo "  ${DATA_DIR} is not mounted, so it is not copied. Mount a volume at ${DATA_DIR} and run mcphub-migrate again."
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "  ${dest} already exists and is left unchanged. While the old mount is in place it takes precedence;"
    echo "  compare both files, keep the one you want in ${dest}, then remove the mount."
  else
    for file in "$LEGACY_SETTINGS" "${SIDECARS[@]/#/$LEGACY_SETTINGS}"; do
      [ -f "$file" ] || continue
      to="${DATA_DIR}/${file##*/}"
      if [ -e "$to" ] || [ -L "$to" ]; then
        echo "  ${to} already exists, not copying ${file}"
        continue
      fi
      if $dry_run; then
        echo "  would copy ${file} to ${to} (mode 0600, owner ${owner})"
      else
        if (umask 077 && cp -- "$file" "$to") && chown -h "$owner" "$to" && chmod 0600 "$to"; then
          echo "  copied ${file} to ${to} (mode 0600, owner ${owner})"
        else
          echo "  could not copy ${file} to ${to}" >&2
          failed=1
          continue
        fi
      fi
      copied=$((copied + 1))
    done
    echo "  Next: remove the ${LEGACY_SETTINGS} mount (and MCPHUB_SETTING_PATH if it points there),"
    echo "  so MCPHub uses ${dest}. Changes made to the old file after this copy are not carried over."
  fi
fi

if $dry_run; then
  echo "Summary (dry run, nothing changed): ${changed} entries would be handed to ${owner}, ${copied} legacy files would be copied, ${foreign} entries of other owners stay as they are."
else
  echo "Summary: ${changed} entries handed to ${owner}, ${copied} legacy files copied, ${foreign} entries of other owners left unchanged."
fi
if [ "$foreign" -gt 0 ]; then
  echo "Entries owned by another uid (for example a ./data directory created by the host user) are"
  echo "never changed. If MCPHub still cannot write them, hand them to uid ${target_uid} on the host:"
  echo "  sudo chown -R ${owner} ./data"
fi
if [ "$failed" -ne 0 ]; then
  echo "mcphub-migrate: some changes failed, see the errors above" >&2
  exit 1
fi
