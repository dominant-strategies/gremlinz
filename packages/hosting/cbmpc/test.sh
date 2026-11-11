#!/usr/bin/env bash
# Run cb-mpc's own crypto and zero-knowledge unit tests on our wasm32 build (test-inner.sh). Builds first if the
# build tree is missing. Extra arguments go to the test binary, e.g. --gtest_filter='*Paillier*'.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=emscripten/emsdk:6.0.13@sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a
cache=${BUILD_CACHE:-$PWD/.build}
[ -d "$cache/cb-mpc/obj" ] || BUILD_CACHE="$cache" ./build.sh --check
docker run --rm -v "$PWD:/src:ro" -v "$cache:/build" "$IMAGE" bash /src/test-inner.sh "$@"
