# Site image: the board (API + pages) serving the static site (home, /hatch/) on one origin. Build:
#   docker buildx build -f site.Dockerfile --build-arg VITE_EGG_IMAGE=<registry>/egg@sha256:… -t gremlins/site .
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/launch apps/launch
RUN npm ci --workspaces --include-workspace-root \
 && npx tsc -b packages/hatch packages/hosting packages/egg

# Which egg build the hatch page launches (image digest; optional release bundle for Docker-less moves).
ARG VITE_EGG_IMAGE
ARG VITE_EGG_ARTIFACT_URL=""
ARG VITE_EGG_ARTIFACT_SHA256=""
RUN test -n "$VITE_EGG_IMAGE" || (echo "VITE_EGG_IMAGE build arg is required (image pinned by digest)" && exit 1) \
 && cd apps/launch && npx vite build

COPY apps/board apps/board
# --install-links copies @gremlins/hatch (built above) into the board's node_modules with its dependencies.
RUN cd apps/board && npm install --omit=dev --install-links --no-audit --no-fund

FROM node:24-slim
WORKDIR /app/board
COPY --from=build /app/apps/board /app/board
COPY --from=build /app/apps/launch/dist /app/site
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 BOARD_DB=/data/board.db BOARD_SITE_DIR=/app/site
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "src/main.ts"]
