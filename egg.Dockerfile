# Egg image: egg supervisor + gremlin runtime (Hermes, from dominant-strategies/gremlin-runtime). Build:
#   docker buildx build --platform linux/amd64 -f egg.Dockerfile \
#     --build-arg HERMES_RUNTIME_REF=<commit sha of gremlin-runtime> -t gremlins/egg .
# Deployed by digest only (cloud-init pins image@sha256:…), never by tag.
#
# Users: the egg and gremlin-run start as root only so gremlin-run can start each child as its own user:
#   gremlin  owns /var/lib/gremlin (seed, keys, ledger; 0700) and runs the inference gateway and gremlin-mcp
#   hermes   owns /var/lib/gremlin-hermes and runs Hermes; it cannot read /var/lib/gremlin
# /opt/gremlin-runtime (plugin, skills, Hermes source) and /app are root-owned and read-only to both.

ARG HERMES_RUNTIME_REF=main

FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/launch/package.json apps/launch/package.json
RUN npm ci --workspaces --include-workspace-root \
 && npx tsc -b packages/hatch packages/treasury packages/hosting packages/egg packages/gremlin-mcp \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:24-slim AS hermes
ARG HERMES_RUNTIME_REF
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv python install 3.14
RUN git init -q /opt/gremlin-runtime \
 && cd /opt/gremlin-runtime \
 && git remote add origin https://github.com/dominant-strategies/gremlin-runtime.git \
 && git fetch -q --depth 1 origin "$HERMES_RUNTIME_REF" \
 && git checkout -q FETCH_HEAD \
 && git log -1 --format='gremlin-runtime %H %s' \
 && rm -rf .git
RUN PY=$(uv python find 3.14) \
 && cd /opt/gremlin-runtime \
 && "$PY" -m pm.build_env --source . --python "$PY" --out /opt/hermes/venv --extra mcp --record-selection \
 && /opt/hermes/venv/bin/hermes --version

FROM node:24-slim
LABEL org.opencontainers.image.source=https://github.com/dominant-strategies/gremlinz \
      org.opencontainers.image.description="Gremlin egg: egg supervisor + gremlin runtime (Hermes)" \
      org.opencontainers.image.licenses=MIT
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps && rm -rf /var/lib/apt/lists/* \
 && groupadd --system gremlin && useradd --system --gid gremlin --home-dir /var/lib/gremlin --shell /usr/sbin/nologin gremlin \
 && groupadd --system hermes && useradd --system --gid hermes --home-dir /var/lib/gremlin-hermes --shell /usr/sbin/nologin hermes \
 && mkdir -p /var/lib/gremlin /var/lib/gremlin-hermes /etc/gremlin \
 && chown gremlin:gremlin /var/lib/gremlin && chmod 0700 /var/lib/gremlin \
 && chown hermes:hermes /var/lib/gremlin-hermes && chmod 0700 /var/lib/gremlin-hermes
COPY --from=hermes /opt/python /opt/python
COPY --from=hermes /opt/gremlin-runtime /opt/gremlin-runtime
COPY --from=hermes /opt/hermes /opt/hermes
COPY --from=build /app /app
ENV NODE_ENV=production \
    GREMLIN_HOME=/var/lib/gremlin GREMLIN_LAUNCH=/etc/gremlin/launch.json \
    HERMES_HOME=/var/lib/gremlin-hermes HERMES_BIN=/opt/hermes/venv/bin/hermes GREMLIN_RUNTIME_DIR=/opt/gremlin-runtime \
    AUTOMATON_DIR=/var/lib/gremlin-hermes \
    GREMLIN_SEPARATE_USERS=1 \
    GREMLIN_RUNTIME="exec node /app/packages/gremlin-mcp/dist/runner/main.js"
WORKDIR /app
VOLUME ["/var/lib/gremlin", "/var/lib/gremlin-hermes"]
CMD ["node", "packages/egg/dist/main.js"]
