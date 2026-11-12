# Hardened MCPHub with external MCP server containers

A Docker Compose example that runs MCPHub with a locked-down container and
keeps MCP servers out of the MCPHub container.

```bash
docker compose up -d --build
docker compose logs mcphub | grep "Generated admin password"
# UI: http://127.0.0.1:3000  (change the port with MCPHUB_PORT)
```

The MCPHub image is built from the repository root (`../../..`) with
`RUN_AS=10001:10001`. The example needs an image that has the uid 10001
`mcphub` user, `/app/data` and `/home/mcphub`; `samanhappy/mcphub:latest` does
not have them yet, and with it the seed fails because the volumes are owned by
root. Once a release with that layout exists, set `MCPHUB_IMAGE` to its tag
and digest (`samanhappy/mcphub:<version>@sha256:<digest>`) and start without
`--build`. With `--build`, Compose rebuilds from source and tags the result as
`MCPHUB_IMAGE` (default `mcphub-example:local`).

## Why external containers

A `stdio` server is a child process inside the MCPHub container. It runs as the
same uid as MCPHub and can read everything MCPHub can read, including the
settings, credential store and encryption key in `/app/data`, and therefore the
secrets of every other server. Here the MCP servers run in their own containers
with their own filesystem and uid, on an internal network, and MCPHub reaches
them as `streamable-http` upstreams.

| Service | What it is |
| --- | --- |
| `mcphub` | MCPHub, published on `127.0.0.1` only |
| `everything` | `@modelcontextprotocol/server-everything` 2.3.0, native streamable-http (built from `everything/`) |
| `fetch-gateway` | stdio-only `mcp-server-fetch` behind `mcp-proxy`, served as `/mcp` and `/sse` (built from `fetch-gateway/`) |
| `mcphub-seed` | one-shot, copies `mcp_settings.json` into the data volume if none exists |

The top-level packages (`server-everything`, `mcp-proxy`,
`mcp-server-fetch`) are version-pinned and installed at build time, from
digest-pinned base images. Nothing is downloaded when the MCP server containers
start. Their transitive npm and pip dependencies are not locked and resolve to
the newest matching versions at build time. For reproducible builds, add a
`package-lock.json` (`npm ci`) and hash-pinned requirements
(`pip install --require-hashes -r ...`).

## What the flags do

| Setting | Effect |
| --- | --- |
| `user: "10001:10001"` | Runs unprivileged from the first process; the entrypoint does not need root |
| `read_only: true` | Root filesystem is immutable; only `/tmp` (tmpfs) and the named volumes are writable |
| `cap_drop: [ALL]` | No Linux capabilities |
| `no-new-privileges` | setuid binaries cannot gain privileges |
| `tmpfs: /tmp` | Writable scratch space that disappears on restart (`nosuid`; `noexec` on the MCP server containers) |
| `mcphub-data` volume | `/app/data`: settings, users, credentials and their key |
| `mcphub-home` volume | `HOME`: the pre-installed `mcp-server-fetch`, plus npx/uvx caches. It must be a volume, not tmpfs, otherwise the pre-installed tool is hidden. A fresh named volume is initialised from the image with owner 10001 |
| `pids_limit`, `mem_limit`, `cpus` | Modest defaults against fork bombs and runaway servers; raise them if your servers need it |
| `127.0.0.1:${MCPHUB_PORT:-3000}:3000` | Not reachable from other hosts; put a reverse proxy with TLS in front |
| `mcp` network, `internal: true` | MCP servers have no route to or from the internet |
| `egress` network | Added only to `fetch-gateway`, because the fetch tool downloads web pages. `everything` does not need it |
| HEALTHCHECK | Inherited from the image (`/livez`) |

Notes on the example:

- **Settings live in the data volume.** MCPHub rewrites `mcp_settings.json` and
  writes credential and approval files next to it, so it cannot be a read-only
  mount. `mcphub-seed` copies the example file on the first start and never
  overwrites an existing one. Later changes are made in the UI or in the volume.
- **`"owner": "admin"`** in the settings marks the servers as admin-owned.
  MCPHub's SSRF guard blocks private addresses (such as the Compose network)
  for servers without an admin owner. Alternatively, allow the network range
  with `network.allowedCidrs` in the system configuration.
- `everything` needs `HOST=0.0.0.0` (it binds loopback by default), and
  `mcp-proxy` needs `--allowed-host fetch-gateway:8080` (it rejects other Host
  headers by default). Both are set in `compose.yaml`.
- `mcp-proxy` and `mcp-server-fetch` live in separate virtualenvs because their
  current releases require incompatible `mcp` SDK ranges.

## Gateway endpoints have no auth

The `everything` and `fetch-gateway` HTTP endpoints accept any caller that can
reach them. That is why they sit only on the internal `mcp` network with no
published ports. Do not publish them. For defence in depth, enable a bearer
token on the gateway and send it from MCPHub.

Put the token in a `.env` file next to `compose.yaml` (keep it out of git):

```bash
echo "FETCH_GATEWAY_TOKEN=$(openssl rand -hex 32)" > .env
```

Pass it to both services in `compose.yaml`. Each service needs its own
`environment:` entry. If only the gateway gets it, MCPHub gets 401 responses:

```yaml
services:
  fetch-gateway:
    environment:
      MCP_PROXY_AUTH_TOKEN: ${FETCH_GATEWAY_TOKEN}
  mcphub:
    environment:
      FETCH_GATEWAY_TOKEN: ${FETCH_GATEWAY_TOKEN}   # expanded in the settings below
```

Add the header to the `fetch` server in the settings:

```json
"fetch": {
  "type": "streamable-http",
  "url": "http://fetch-gateway:8080/mcp",
  "headers": { "Authorization": "Bearer ${FETCH_GATEWAY_TOKEN}" },
  "owner": "admin"
}
```

`mcphub-seed` never overwrites an existing settings file, so editing
`mcp_settings.json` here only takes effect on a fresh volume. On a running
setup, add the header in the UI, or run `docker compose down -v` (this deletes
all MCPHub data) and start again to re-seed.

## Never mount the Docker socket

Do not mount `/var/run/docker.sock` into MCPHub or any MCP server. Access to the
socket is root on the host and undoes every flag above.

## Upgrading from old root images

See the uid 10001 paragraph in the
[Docker setup guide](../../../docs/configuration/docker-setup.mdx). With this
example, MCPHub never runs as root, so it cannot fix ownership itself. The
existing data must belong to uid/gid 10001, for example:

```bash
docker run --rm -v mcphub-data:/d alpine chown -R 10001:10001 /d
```

## Clean up

```bash
docker compose down -v   # also deletes the data and home volumes
```
