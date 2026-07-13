# Shared runtime image for all wrapper agents.
# Agent config/tools are mounted read-only at /app/agent (inside /app so tool
# modules resolve pi packages from /app/node_modules).
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY packages/runtime/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY packages/runtime/src ./src

# Own /data so a fresh named volume mounted here inherits node ownership
# (the container runs as non-root, and Docker seeds an empty volume from the
# image path's owner + contents).
RUN mkdir -p /data && chown node:node /data

USER node
ENV AGENT_DIR=/app/agent DATA_DIR=/data
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
