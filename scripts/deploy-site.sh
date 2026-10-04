#!/usr/bin/env bash
# Build the site image and deploy it to a server over SSH (no registry needed).
#   EGG_IMAGE=ghcr.io/<owner>/gremlins-egg@sha256:… SITE_DOMAIN=gremlins.example.com scripts/deploy-site.sh user@host
# Optional: EGG_ARTIFACT_URL, EGG_ARTIFACT_SHA256 (release bundle for Docker-less moves), PLATFORM (default linux/amd64).
set -euo pipefail
HOST=${1:?usage: deploy-site.sh user@host}
: "${EGG_IMAGE:?set EGG_IMAGE to the egg image pinned by digest}"
: "${SITE_DOMAIN:?set SITE_DOMAIN}"
PLATFORM=${PLATFORM:-linux/amd64}
TAG=$(git rev-parse --short HEAD)

docker buildx build --platform "$PLATFORM" -f site.Dockerfile \
  --build-arg VITE_EGG_IMAGE="$EGG_IMAGE" \
  --build-arg VITE_EGG_ARTIFACT_URL="${EGG_ARTIFACT_URL:-}" \
  --build-arg VITE_EGG_ARTIFACT_SHA256="${EGG_ARTIFACT_SHA256:-}" \
  -t "gremlins/site:$TAG" --load .

echo "copying image to $HOST…"
docker save "gremlins/site:$TAG" | gzip | ssh "$HOST" 'gunzip | docker load'
ssh "$HOST" 'mkdir -p ~/gremlins'
scp deploy/compose.yaml deploy/Caddyfile "$HOST:~/gremlins/"
ssh "$HOST" "cd ~/gremlins && SITE_TAG=$TAG SITE_DOMAIN=$SITE_DOMAIN docker compose up -d && docker compose ps"
echo "deployed gremlins/site:$TAG to https://$SITE_DOMAIN"
