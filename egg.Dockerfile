# Egg image. Build: docker build -f egg.Dockerfile -t gremlins/egg .
# Deployed by digest only (cloud-init pins image@sha256:…), never by tag.
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/hatch packages/hatch
COPY packages/treasury packages/treasury
COPY packages/egg packages/egg
COPY packages/hosting packages/hosting
COPY apps/launch/package.json apps/launch/package.json
RUN npm ci --workspaces --include-workspace-root \
 && npx tsc -b packages/egg \
 && npm prune --omit=dev --workspaces --include-workspace-root

# Agent runtime (fork of Conway's automaton). Built separately: it has its own lockfile and native deps.
FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/hatch /packages/hatch
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY runtime/ ./
RUN npx tsc && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production GREMLIN_HOME=/var/lib/gremlin GREMLIN_LAUNCH=/etc/gremlin/launch.json \
    GREMLIN_RUNTIME="node /app/runtime/dist/index.js --gremlin-setup && exec node /app/runtime/dist/index.js --run"
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages packages
COPY --from=runtime /src runtime
COPY --from=runtime /packages/hatch /packages/hatch
USER node
VOLUME ["/var/lib/gremlin"]
CMD ["node", "packages/egg/dist/main.js"]
