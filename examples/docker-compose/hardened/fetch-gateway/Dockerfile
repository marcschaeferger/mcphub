# syntax=docker/dockerfile:1.7
# mcp-server-fetch (stdio only) behind mcp-proxy, which exposes it as
# streamable-http (/mcp) and SSE (/sse). Both packages are pinned and
# installed at build time. Python image: same tag and digest as the main
# MCPHub Dockerfile.
FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

ARG MCP_PROXY_VERSION=0.15.0
ARG MCP_SERVER_FETCH_VERSION=2026.11.11
# Two venvs on purpose: the two packages currently require incompatible
# ranges of the "mcp" SDK (mcp-proxy <2, mcp-server-fetch >=2.3), and they
# only talk over stdio, so they do not need to share one environment.
RUN python -m venv /opt/proxy \
  && /opt/proxy/bin/pip install --no-cache-dir "mcp-proxy==${MCP_PROXY_VERSION}" \
  && python -m venv /opt/fetch \
  && /opt/fetch/bin/pip install --no-cache-dir "mcp-server-fetch==${MCP_SERVER_FETCH_VERSION}"

USER 10003:10003
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 8080), 3)"]

ENTRYPOINT ["/opt/proxy/bin/mcp-proxy"]
CMD ["--host", "0.0.0.0", "--port", "8080", "--", "/opt/fetch/bin/mcp-server-fetch"]
