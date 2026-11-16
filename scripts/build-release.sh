#!/usr/bin/env bash
# Build one gremlin release for a platform: the egg image and the matching release bundle (same /app tree) for
# Docker-less hosts. Prints what goes into launch data: image (pin by digest after pushing) and artifact sha256.
#
#   HERMES_RUNTIME_REF=<full-sha> scripts/build-release.sh [platform] [tag]     e.g. scripts/build-release.sh linux/amd64 gremlins/egg:dev
set -euo pipefail
cd "$(dirname "$0")/.."
PLATFORM=${1:-linux/amd64}
TAG=${2:-gremlins/egg:dev}
ARCH=${PLATFORM#linux/}
: "${HERMES_RUNTIME_REF:?set HERMES_RUNTIME_REF to the reviewed gremlin-runtime commit}"
[[ "$HERMES_RUNTIME_REF" =~ ^[a-f0-9]{40}$ ]] || { echo 'release: Hermes must be pinned to a full commit SHA' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'release: commit the working tree before building a release' >&2; exit 1; }
BUILD_COMMIT=$(git rev-parse HEAD)
BUILD_CONTEXT=$(mktemp -d "${TMPDIR:-/tmp}/gremlinz-release.XXXXXX")
trap 'rm -rf "$BUILD_CONTEXT"' EXIT
git archive "$BUILD_COMMIT" | tar -xf - -C "$BUILD_CONTEXT"
OUT=release
mkdir -p "$OUT"

docker buildx build --platform "$PLATFORM" --build-arg HERMES_RUNTIME_REF="$HERMES_RUNTIME_REF" --build-arg GREMLIN_BUILD_COMMIT="$BUILD_COMMIT" -f "$BUILD_CONTEXT/egg.Dockerfile" -t "$TAG" --load "$BUILD_CONTEXT"

BUNDLE="$OUT/gremlin-linux-$ARCH.tgz"
docker run --rm --platform "$PLATFORM" --entrypoint tar "$TAG" -czf - -C /app . > "$BUNDLE"
SHA=$(shasum -a 256 "$BUNDLE" | cut -d' ' -f1)
echo "$SHA  $(basename "$BUNDLE")" > "$BUNDLE.sha256"

echo
echo "source:   $BUILD_COMMIT"
echo "runtime:  $HERMES_RUNTIME_REF"
echo "image:    $TAG  (push, then pin as <registry>/<name>@sha256:<digest>)"
echo "bundle:   $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
echo "sha256:   $SHA"
