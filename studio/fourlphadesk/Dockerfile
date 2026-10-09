# 4lpha bStock Desk: Studio seller agent (A2A + ERC-8183), env-only hosting (Railway or any container host).
# Build context = the project root (the folder holding package.json, pnpm-workspace.yaml and app/agent).
# No secret is ever in the image: the keystore, its password and every key arrive as environment variables.

FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /srv
# manifests first, so the dependency layer is cached
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY app/agent/package.json app/agent/pnpm-workspace.yaml app/agent/
RUN pnpm install --frozen-lockfile
COPY app/agent/tsconfig.json app/agent/studio.toml app/agent/
COPY app/agent/src app/agent/src
RUN pnpm --filter fourlphadesk-agent run build

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production \
    CI=true
RUN corepack enable
WORKDIR /srv
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY app/agent/package.json app/agent/pnpm-workspace.yaml app/agent/
# production dependencies only (no typescript, no tsx, no test tooling)
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
# the runtime files of the agent: compiled code and its config (studio.toml holds public facts only:
# the wallet ADDRESS, the Pieverse key hash, price, caps; never a key)
COPY --from=build /srv/app/agent/dist app/agent/dist
COPY app/agent/studio.toml app/agent/studio.toml
# the runtime writes the keystore it is handed in WALLET_KEYSTORE_JSON (mode 0600) into /srv/.studio/wallets
# on the container's own disk, then removes the variable; the directory must belong to the app user
RUN mkdir -p /srv/.studio && chown -R node:node /srv/.studio
# the x402 spend ledger and the audit log are written under the PROJECT root's .studio (/srv/app/agent/.studio);
# without this directory both writes fail silently and the daily cap resets on every restart
RUN mkdir -p /srv/app/agent/.studio && chown node:node /srv/app/agent/.studio && chmod 0700 /srv/app/agent/.studio
USER node
WORKDIR /srv/app/agent
# Railway sets PORT; without it the agent serves its A2A port (9000). It binds 0.0.0.0 and answers GET /ping.
CMD ["node", "dist/unifiedMain.js"]
