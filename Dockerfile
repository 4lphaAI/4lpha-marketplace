FROM node:22.23.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY scripts/railway-build-role-bundles.ts scripts/billing-build-adapter.ts scripts/railway-build-app-inventory.ts ./scripts/
COPY scripts/lp-worker.ts scripts/venus-worker.ts scripts/billing-worker.ts ./scripts/
COPY deploy/railway-launcher.c ./deploy/railway-launcher.c

RUN mkdir -p /image-app/dist /image-app/artifacts \
    && node --import tsx scripts/railway-build-role-bundles.ts --out /image-app/dist/railway \
    && node --import tsx scripts/billing-build-adapter.ts \
       --out /image-app/artifacts/billing-adapter.mjs \
       --source-out /tmp/billing-adapter-source.json \
    && npx esbuild scripts/railway-build-app-inventory.ts --bundle --platform=node \
       --target=node22 --format=esm --packages=bundle \
       --legal-comments=none --outfile=/tmp/railway-build-app-inventory.mjs \
    && cp package.json package-lock.json /image-app/ \
    && cp -a node_modules /image-app/node_modules \
    && npm prune --omit=dev --ignore-scripts --prefix /image-app \
    && rm -f /image-app/node_modules/.package-lock.json \
    && node /tmp/railway-build-app-inventory.mjs \
       --app-root /image-app --lock /workspace/package-lock.json \
       --out /image-app/artifacts/app-inventory.json

RUN gcc -std=c17 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 \
      -fstack-protector-strong -Wl,-z,relro,-z,now \
      -o /tmp/railway-launcher deploy/railway-launcher.c \
    && chmod 0555 /tmp/railway-launcher

RUN curl --fail --silent --show-error --location \
      --output /tmp/aws_signing_helper \
      https://rolesanywhere.amazonaws.com/releases/1.8.4/X86_64/Linux/Amzn2023/aws_signing_helper \
    && test "$(wc -c < /tmp/aws_signing_helper)" = "12094568" \
    && echo "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9  /tmp/aws_signing_helper" | sha256sum -c - \
    && test "$(od -An -tx1 -N4 /tmp/aws_signing_helper | tr -d ' \n')" = "7f454c46" \
    && chmod 0555 /tmp/aws_signing_helper

FROM node:22.23.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96

ENV NODE_ENV=production
LABEL org.opencontainers.image.base.name="docker.io/library/node:22.23.2-bookworm-slim" \
      org.opencontainers.image.base.digest="sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96" \
      org.4lpha.base-manifest-digest="sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96"

WORKDIR /app
COPY --from=builder --chown=0:0 /image-app/package.json ./package.json
COPY --from=builder --chown=0:0 /image-app/node_modules ./node_modules
COPY --from=builder --chown=0:0 /image-app/dist ./dist
COPY --from=builder --chown=0:0 /image-app/artifacts ./artifacts
COPY --from=builder --chown=0:0 /tmp/railway-launcher /usr/local/bin/railway-launcher
COPY --from=builder --chown=0:0 /tmp/aws_signing_helper /usr/local/bin/aws_signing_helper

RUN chmod -R go-w /app \
    && chmod 0555 /usr/local/bin/railway-launcher /usr/local/bin/aws_signing_helper \
    && mkdir -p /run/4lpha \
    && chown 10001:10001 /run/4lpha \
    && chmod 0700 /run/4lpha

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/railway-launcher"]
CMD ["api"]
