FROM node:22-slim AS base

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone and build OpenClaw from dist/hosted branch
ARG OPENCLAW_REPO=https://github.com/worknomicai/openclaw.git
ARG OPENCLAW_BRANCH=dist/hosted

RUN git clone --depth 1 --branch ${OPENCLAW_BRANCH} ${OPENCLAW_REPO} .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Install Clawsy plugin
COPY plugin/ /tmp/clawsy-plugin/
RUN cd /tmp/clawsy-plugin && pnpm install --frozen-lockfile && pnpm build
RUN pnpm add file:/tmp/clawsy-plugin

# Copy default configs and personalities
COPY openclaw-dist/default-config/ /app/dist/default-config/
COPY openclaw-dist/personalities/ /app/dist/personalities/

# Copy entrypoint
COPY openclaw-dist/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Data volume for user-specific state
VOLUME ["/data/.openclaw"]

EXPOSE 18789

ENV OPENCLAW_CONFIG_DIR=/data/.openclaw
ENV NODE_ENV=production

ENTRYPOINT ["/app/entrypoint.sh"]
