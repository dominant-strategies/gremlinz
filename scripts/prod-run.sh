#!/usr/bin/env bash
# Deploy and run the gremlinz board (site + API) on the production server, inside its tmux pane:
#   cd ~/gremlinz && scripts/prod-run.sh
# Pulls main, installs, loads the server's settings, builds the site and starts the board.
# Settings live in an env file outside git (template: deploy/board.env.example), mode 600, every value
# single-quoted so it can be sourced. Default ~/gremlinz-board.env; GREMLINZ_ENV=<path> picks another.
# --no-pull runs what is checked out.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=${GREMLINZ_ENV:-$HOME/gremlinz-board.env}
[ -f "$ENV_FILE" ] || { echo "prod-run: no env file at $ENV_FILE (copy deploy/board.env.example)" >&2; exit 1; }
if [ "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")" != 600 ]; then
  echo "prod-run: $ENV_FILE holds secrets; chmod 600 it" >&2; exit 1
fi

if [ "${1:-}" != --no-pull ]; then
  git pull --ff-only
fi
npm run setup

# Loaded before the build too: VITE_* settings shape the site.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

echo "prod-run: $(git log -1 --format='%h %s') with $ENV_FILE"
exec npm run dev
