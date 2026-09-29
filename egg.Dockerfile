# Egg image. Build: docker build -f egg.Dockerfile -t gremlins/egg .
# Deployed by digest only (cloud-init pins image@sha256:…), never by tag.
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/hatch packages/hatch
COPY packages/treasury packages/treasury
COPY packages/egg packages/egg
RUN npm ci --workspaces --include-workspace-root \
 && npx tsc -b packages/egg \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-slim
ENV NODE_ENV=production GREMLIN_HOME=/var/lib/gremlin GREMLIN_LAUNCH=/etc/gremlin/launch.json
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages packages
USER node
VOLUME ["/var/lib/gremlin"]
CMD ["node", "packages/egg/dist/main.js"]
