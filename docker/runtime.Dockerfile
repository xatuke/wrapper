# Shared runtime image for all wrapper agents.
# Agent config/tools are mounted read-only at /app/agent (inside /app so tool
# modules resolve pi packages from /app/node_modules).
# Pinned by digest: a re-pushed tag can't change what gets built. Bump tag + digest together.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ENV NODE_ENV=production
WORKDIR /app

# Install exactly what package-lock.json records. The lockfile belongs to the
# workspace root, so the root manifest and every workspace manifest must be here
# for `npm ci` to accept it; deps hoist to /app/node_modules.
COPY package.json package-lock.json .npmrc ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace=@wrapper/agent-runtime && npm cache clean --force

COPY packages/runtime/src ./packages/runtime/src

# Own /data so a fresh named volume mounted here inherits node ownership
# (the container runs as non-root, and Docker seeds an empty volume from the
# image path's owner + contents).
RUN mkdir -p /data && chown node:node /data

USER node
ENV AGENT_DIR=/app/agent DATA_DIR=/data
CMD ["./node_modules/.bin/tsx", "packages/runtime/src/main.ts"]
