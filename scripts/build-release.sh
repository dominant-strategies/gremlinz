#!/usr/bin/env bash
# Build one gremlin release for a platform: the egg image and the matching release bundle (same /app tree) for
# Docker-less hosts. Prints what goes into launch data: image (pin by digest after pushing) and artifact sha256.
#
#   scripts/build-release.sh [platform] [tag]     e.g. scripts/build-release.sh linux/amd64 gremlins/egg:dev
set -euo pipefail
PLATFORM=${1:-linux/amd64}
TAG=${2:-gremlins/egg:dev}
ARCH=${PLATFORM#linux/}
OUT=release
mkdir -p "$OUT"

docker buildx build --platform "$PLATFORM" -f egg.Dockerfile -t "$TAG" --load .

BUNDLE="$OUT/gremlin-linux-$ARCH.tgz"
docker run --rm --platform "$PLATFORM" --entrypoint tar "$TAG" -czf - -C /app . > "$BUNDLE"
SHA=$(shasum -a 256 "$BUNDLE" | cut -d' ' -f1)
echo "$SHA  $(basename "$BUNDLE")" > "$BUNDLE.sha256"

echo
echo "image:    $TAG  (push, then pin as <registry>/<name>@sha256:<digest>)"
echo "bundle:   $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
echo "sha256:   $SHA"
