FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files first for layer caching
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy the rest of the source
COPY . .

# Build OpenClaw
RUN pnpm build || true

# Copy entrypoint and make executable
RUN chmod +x /app/dist/scripts/entrypoint.sh

# Data volume for user-specific state
VOLUME ["/data/.openclaw"]

EXPOSE 18789

ENV OPENCLAW_CONFIG_DIR=/data/.openclaw
ENV NODE_ENV=production

ENTRYPOINT ["/app/dist/scripts/entrypoint.sh"]
