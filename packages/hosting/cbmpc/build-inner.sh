#!/usr/bin/env bash
# Runs inside the pinned Emscripten image (build.sh). Fetches pinned sources, builds OpenSSL and cb-mpc for wasm32 and
# links them with shim.cpp into /out/cbmpc.mjs + /out/cbmpc.wasm.
set -euo pipefail

OPENSSL_VERSION=3.6.4
OPENSSL_SHA256=9bffaa1ad1e07b354c21bd3324ec02fa15579f45a7d0494b3e74bc449b7333ef
# coinbase/cb-mpc v0.2.2 + #137 (2026-10-05). A commit id pins the whole tree, vendored secp256k1 included.
CBMPC_REPO=https://github.com/coinbase/cb-mpc.git
CBMPC_COMMIT=0b716706f998633912ee2be9b9bf8909aed66088

HERE=/src
W=/build
OUT=/out
JOBS=$(nproc)
mkdir -p "$W" "$OUT"
export SOURCE_DATE_EPOCH=0

# ---------------------------------------------------------------- OpenSSL (libcrypto only)
cd "$W"
if [ -n "${REUSE_OPENSSL:-}" ] && [ -f "$W/openssl-out/lib/libcrypto.a" ]; then echo 'reusing OpenSSL'; else
curl -fsSL -o openssl.tar.gz "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz"
echo "${OPENSSL_SHA256}  openssl.tar.gz" | sha256sum -c -
rm -rf openssl && mkdir openssl && tar -xzf openssl.tar.gz -C openssl --strip-components=1
cd openssl
# cb-mpc's own patch (see its scripts/openssl): expose the curve25519 internals.
sed -i -e 's/^static//' crypto/ec/curve25519.c
# wasm32 with 64-bit bignum limbs (BN_ULONG = unsigned long long, __int128 products): cb-mpc's constant-time modular
# arithmetic and bn256 code assume 64-bit limbs, so we keep them instead of falling back to variable-time code.
cp "$HERE/openssl-wasm32.conf" Configurations/60-gremlins-wasm32.conf
CC=emcc AR=emar RANLIB=emranlib ./Configure gremlins-wasm32 \
  --prefix="$W/openssl-out" --libdir=lib -static no-asm no-shared no-async no-dso no-engine no-threads \
  -DOPENSSL_NO_SECURE_MEMORY \
  no-afalgeng no-apps no-aria no-autoload-config no-bf no-camellia no-cast no-chacha no-cmac no-cms no-crypto-mdebug \
  no-comp no-cmp no-ct no-des no-dh no-dgram no-dsa no-dtls no-dynamic-engine no-ec2m no-egd no-external-tests \
  no-gost no-http no-idea no-mdc2 no-md2 no-md4 no-module no-nextprotoneg no-ocb no-ocsp no-psk no-padlockeng \
  no-poly1305 no-quic no-rc2 no-rc4 no-rc5 no-rfc3779 no-scrypt no-sctp no-seed no-siphash no-sm2 no-sm3 no-sm4 \
  no-sock no-srtp no-srp no-ssl-trace no-ssl3 no-stdio no-tests no-tls no-ts no-unit-test no-uplink no-whirlpool \
  no-zlib
make -s build_generated
make -s -j"$JOBS" libcrypto.a
mkdir -p "$W/openssl-out/lib" "$W/openssl-out/include"
cp libcrypto.a "$W/openssl-out/lib/"
cp -r include/openssl "$W/openssl-out/include/"
grep -q '^# *define SIXTY_FOUR_BIT$' include/openssl/configuration.h || { echo 'OpenSSL is not on 64-bit limbs'; exit 1; }
fi

# ---------------------------------------------------------------- cb-mpc
cd "$W"
rm -rf cb-mpc && mkdir cb-mpc && cd cb-mpc
export GIT_LFS_SKIP_SMUDGE=1 # the docs PDFs are LFS objects; we need none of them
git init -q && git fetch -q --depth 1 "$CBMPC_REPO" "$CBMPC_COMMIT" && git checkout -q FETCH_HEAD
test "$(git rev-parse HEAD)" = "$CBMPC_COMMIT"
for p in "$HERE"/patches/*.patch; do patch -p1 < "$p"; done

# The upstream CMake refuses non-64-bit targets; build the sources it would build, with its flags.
CXXFLAGS=(-std=c++17 -O2 -fvisibility=hidden -fno-operator-names -DNDEBUG -DNO_DEPRECATED_OPENSSL
  -Wno-attributes -Wno-parentheses -Wno-reorder -Wno-missing-braces -Wno-switch -Wno-sign-compare -Wno-unused
  -Wno-shorten-64-to-32 -Wno-tautological-undefined-compare -Wno-#pragma-messages -Wno-vla-extension
  -Wno-deprecated-declarations -Wno-null-dereference
  -I include -I include-internal -I vendors -I "$W/openssl-out/include")
mkdir -p obj
# Everything below the public API, and of the API only 2-party ECDSA (what the hatch uses).
{ find src/cbmpc/core src/cbmpc/crypto src/cbmpc/zk src/cbmpc/protocol -name '*.cpp'
  echo src/cbmpc/api/ecdsa2pc.cpp; echo src/cbmpc/c_api/common.cpp; echo src/cbmpc/c_api/ecdsa2pc.cpp; } | sort > sources.txt
xargs -P "$JOBS" -I{} sh -c 'em++ "$@" -c {} -o obj/$(echo {} | tr / _).o' _ "${CXXFLAGS[@]}" < sources.txt
em++ "${CXXFLAGS[@]}" -c "$HERE/shim.cpp" -o obj/shim.o

# ---------------------------------------------------------------- link
em++ -O2 obj/*.o "$W/openssl-out/lib/libcrypto.a" -o "$OUT/cbmpc.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCbmpc -sENVIRONMENT=web,node \
  -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=1048576 -sSTACK_SIZE=1048576 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sFILESYSTEM=0 -sDISABLE_EXCEPTION_CATCHING=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_gz_out_ptr,_gz_out_size,_gz_out_clear,_gz_ecdsa2p_dkg,_gz_ecdsa2p_sign,_gz_ecdsa2p_public_key,_gz_ecdsa2p_private_share \
  -sEXPORTED_RUNTIME_METHODS=ccall,HEAPU8,stringToNewUTF8 \
  -sINCOMING_MODULE_JS_API=onSend,onReceive,takeReceived,instantiateWasm,wasmBinary,print,printErr
sha256sum "$OUT/cbmpc.mjs" "$OUT/cbmpc.wasm"
