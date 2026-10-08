# Egg image: egg supervisor + agent runtime. Build:
#   docker buildx build --platform linux/amd64 -f egg.Dockerfile -t gremlins/egg .
# Deployed by digest only (cloud-init pins image@sha256:…), never by tag.
# The same /app tree, tarred, is the release bundle Conway nests install into /opt/gremlin.

FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Shared packages (workspaces)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/launch/package.json apps/launch/package.json
RUN npm ci --workspaces --include-workspace-root \
 && npx tsc -b packages/hatch packages/treasury packages/hosting packages/egg

# Agent runtime (fork of Conway's automaton): own lockfile, native sqlite; links to the built packages above.
# `npm install` (lockfile-guided) rather than `npm ci`: npm 10 here and npm 11 locally disagree about optional
# peers of the linked workspace packages, which `npm ci` treats as an out-of-sync lockfile.
COPY runtime/package.json runtime/package-lock.json runtime/
RUN cd runtime && npm install --no-audit --no-fund --ignore-scripts && npm rebuild better-sqlite3
COPY runtime runtime
RUN cd runtime && npx tsc

RUN npm prune --omit=dev --workspaces --include-workspace-root \
 && cd runtime && npm prune --omit=dev

FROM node:22-slim
LABEL org.opencontainers.image.source=https://github.com/dominant-strategies/gremlinz \
      org.opencontainers.image.description="Gremlin egg: egg supervisor + agent runtime" \
      org.opencontainers.image.licenses=MIT
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production GREMLIN_HOME=/var/lib/gremlin GREMLIN_LAUNCH=/etc/gremlin/launch.json \
    GREMLIN_RUNTIME="node /app/runtime/dist/index.js --gremlin-setup && exec node /app/runtime/dist/index.js --run"
WORKDIR /app
COPY --from=build /app /app
USER node
VOLUME ["/var/lib/gremlin"]
CMD ["node", "packages/egg/dist/main.js"]
