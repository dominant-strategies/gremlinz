#!/usr/bin/env bash
# Runs inside the Emscripten image after build-inner.sh, on the same /build tree (test.sh): builds cb-mpc's own unit
# tests for crypto and zero-knowledge proofs (the code our wasm32 port touches: bignums, modular arithmetic, curves,
# Paillier, proofs) against the WebAssembly objects, and runs them under Node.
set -euo pipefail
GTEST_SHA256=7315acb6bf10e99f332c8a43f00d5fbb1ee6ca48c52f6b936991b216c586aaad
W=/build
JOBS=$(nproc)
cd "$W"
if [ ! -f gtest/lib.a ]; then
  curl -fsSL -o gtest.tgz https://github.com/google/googletest/releases/download/v1.15.0/googletest-1.15.0.tar.gz
  echo "${GTEST_SHA256}  gtest.tgz" | sha256sum -c -
  rm -rf gtest && mkdir gtest && tar -xzf gtest.tgz -C gtest --strip-components=1
  (cd gtest && em++ -std=c++17 -O2 -fexceptions -I googletest/include -I googletest -c googletest/src/gtest-all.cc -o all.o \
    && em++ -std=c++17 -O2 -fexceptions -I googletest/include -c googletest/src/gtest_main.cc -o main.o && emar rcs lib.a all.o main.o)
fi
cd "$W/cb-mpc"
FLAGS=(-std=c++17 -O2 -fexceptions -DNDEBUG -DNO_DEPRECATED_OPENSSL -fno-operator-names -Wno-everything
  -I include -I include-internal -I vendors -I tests/utils -I tests -I "$W/openssl-out/include" -I "$W/gtest/googletest/include")
mkdir -p tobj
{ ls tests/unit/crypto/test_*.cpp tests/unit/zk/test_*.cpp; find tests/utils/data tests/utils/crypto -name '*.cpp'; } | sort > tsources.txt
xargs -P "$JOBS" -I{} sh -c 'em++ "$@" -c {} -o tobj/$(echo {} | tr / _).o' _ "${FLAGS[@]}" < tsources.txt
em++ -O2 -fexceptions tobj/*.o $(ls obj/*.o | grep -v shim.o) "$W/openssl-out/lib/libcrypto.a" "$W/gtest/lib.a" -o tests.js \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8388608 -sNODERAWFS=1 -sDISABLE_EXCEPTION_CATCHING=0 -sENVIRONMENT=node
node tests.js "$@"
