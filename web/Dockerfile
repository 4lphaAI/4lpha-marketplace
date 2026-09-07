# syntax=docker/dockerfile:1
# Marketplace UI (Next.js, output: "standalone"). Railway service root dir = web/.
#
# TRUST BOUNDARY (CLAUDE.md "Marketplace UI"): this image must never contain a
# repo env file. `.dockerignore` next to this file excludes every `.env*`, and
# the build context is `web/` alone, so the repo-root `.env.local` (operator
# owner key) cannot enter even by accident. Server-only secrets
# (EXECUTION_API_TOKEN, DATA_PLANE_TOKEN, EXECUTION_URL, DATA_PLANE_URL) arrive
# as Railway runtime variables and are read by route handlers only.
#
# NEXT_PUBLIC_* values are BAKED AT BUILD TIME into the browser bundle. Railway
# forwards service variables as build args when they are declared with ARG
# below, so set them on the service BEFORE the first build. They MUST match the
# execution service (EXECUTION_NETWORK / chain / EXECUTION_ENV_SALT) or every
# EIP-712 owner signature is rejected on the domain salt.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
# --legacy-peer-deps: the image's npm 10 refuses the lockfile's peer graph
# (@coinbase/cdp-sdk -> @solana/kit wants typescript ^5) that npm 11 accepts.
RUN npm ci --legacy-peer-deps --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_EXEC_CHAIN_ID=56
ARG NEXT_PUBLIC_EXEC_NETWORK=mainnet
ARG NEXT_PUBLIC_EXEC_ENV_SALT=
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID \
    NEXT_PUBLIC_EXEC_CHAIN_ID=$NEXT_PUBLIC_EXEC_CHAIN_ID \
    NEXT_PUBLIC_EXEC_NETWORK=$NEXT_PUBLIC_EXEC_NETWORK \
    NEXT_PUBLIC_EXEC_ENV_SALT=$NEXT_PUBLIC_EXEC_ENV_SALT \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0
# Standalone output carries its own pruned node_modules and server.js; static
# assets and public/ are not included by Next and are copied beside it.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
# Next's standalone server honours PORT and HOSTNAME; Railway injects PORT.
CMD ["node", "server.js"]
