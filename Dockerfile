FROM node:22-trixie

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

# Install jq for JSON processing
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Security hardening: Reconfigure node user before copying files
# The node:22-trixie image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
RUN usermod -u 1001 node \
  && groupmod -g 1001 node \
  && chown -R node:node /home/node

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ARG OPENCLAW_VERSION=dev
ENV NODE_ENV=production
ENV OPENCLAW_BUNDLED_VERSION=${OPENCLAW_VERSION}

RUN echo '#!/bin/sh\nnode /app/dist/index.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

# 從官方 uv 鏡像中拷貝執行檔
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# 驗證安裝
RUN uv --version

RUN curl -L "https://github.com/steipete/CodexBar/releases/download/v0.18.0-beta.2/CodexBarCLI-v0.18.0-beta.2-linux-x86_64.tar.gz" \
    | tar -xz -C /usr/bin \
    && chmod +x /usr/bin/codexbar

USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","dist/index.js","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured"]
