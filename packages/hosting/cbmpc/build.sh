#!/usr/bin/env bash
# Rebuild cb-mpc's 2-party ECDSA as WebAssembly (wasm/cbmpc.mjs + wasm/cbmpc.wasm) from pinned sources:
#   Emscripten   emscripten/emsdk:6.0.13, image pinned by digest
#   OpenSSL      3.6.4 release tarball, sha256-checked
#   cb-mpc       coinbase/cb-mpc at a fixed commit, plus patches/ (header guards for wasm32)
# Needs only Docker. The outputs are committed (most machines that build or test this repo have no Emscripten);
# `build.sh --check` rebuilds into a temp dir and fails if the committed files differ, i.e. if they are not exactly
# what these pinned sources produce.
#
#   BUILD_CACHE=dir   keep the build tree there (and with REUSE_OPENSSL=1 skip rebuilding OpenSSL; dev only)
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=emscripten/emsdk:6.0.13@sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a

check=false
[ "${1:-}" = "--check" ] && check=true
# Under this directory, not $TMPDIR: Docker VMs (colima, Docker Desktop) share the home directory, not /var/folders.
out=$PWD/.out
cache=${BUILD_CACHE:-$PWD/.build}
rm -rf "$out" && mkdir -p "$out" "$cache"
trap 'rm -rf "$out"' EXIT

docker run --rm -e REUSE_OPENSSL="${REUSE_OPENSSL:-}" \
  -v "$PWD:/src:ro" -v "$cache:/build" -v "$out:/out" "$IMAGE" bash /src/build-inner.sh

if $check; then
  for f in cbmpc.mjs cbmpc.wasm; do
    cmp -s "$out/$f" "wasm/$f" || { echo "wasm/$f differs from a fresh build of the pinned sources"; exit 1; }
  done
  echo 'wasm/ matches a fresh build'
else
  mkdir -p wasm
  cp "$out/cbmpc.mjs" "$out/cbmpc.wasm" wasm/
  (cd wasm && shasum -a 256 cbmpc.mjs cbmpc.wasm > SHA256SUMS)
  cat wasm/SHA256SUMS
fi
