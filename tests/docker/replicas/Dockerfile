FROM node:22-slim
RUN corepack enable && install -d -o node -g node /app
WORKDIR /app
# Everything below runs as the unprivileged `node` user (uid 1000); /app is
# its own so the test nodes can write settings sidecars next to settings.json.
USER node
RUN corepack prepare pnpm@10.12.4 --activate
COPY --chown=node:node package.json pnpm-lock.yaml .pnpmfile.cjs ./
COPY --chown=node:node patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/build-mcp-client.js ./scripts/build-mcp-client.js
COPY --chown=node:node locales ./locales
COPY --chown=node:node servers.json ./
COPY --chown=node:node tests/docker/replicas ./tests/docker/replicas
RUN pnpm backend:build
ENV DISABLE_WEB=true
CMD ["node", "dist/index.js"]
