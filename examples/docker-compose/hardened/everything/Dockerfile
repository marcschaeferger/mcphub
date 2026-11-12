# syntax=docker/dockerfile:1.7
# @modelcontextprotocol/server-everything, installed at build time with a
# pinned version so nothing is downloaded when the container starts.
# Node image: same tag and digest as the main MCPHub Dockerfile.
FROM node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6

ARG EVERYTHING_VERSION=2.3.0
WORKDIR /opt/everything
RUN npm install --omit=dev --no-audit --no-fund \
      "@modelcontextprotocol/server-everything@${EVERYTHING_VERSION}" \
  && npm cache clean --force

# The base image ships a non-root "node" user (uid 1000); use a fixed uid
# that does not collide with MCPHub's 10001.
USER 10002:10002
ENV PORT=3001 NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "require('net').connect(3001,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["node", "node_modules/.bin/mcp-server-everything"]
CMD ["streamableHttp"]
