// JS face of cb-mpc's 2-party ECDSA for the hatch key (packages/hosting/src/cbmpc.ts).
//
// cb-mpc runs a protocol as one blocking call that sends and receives through a transport. Here `receive` is an
// Asyncify import: the WASM stack is suspended while JS waits for the peer's next message (over HTTP), then resumed.
// One module instance runs one protocol at a time. Results land in a single output buffer (gz_out_*).
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include <cbmpc/c_api/ecdsa_2p.h>

EM_JS(void, gz_js_send, (const uint8_t* data, int size), { Module["onSend"](HEAPU8.slice(data, data + size)); });
// Waits for the peer's next message; returns its length (or -1 when the run was cancelled) and keeps it for gz_js_take.
EM_ASYNC_JS(int, gz_js_receive, (), { return await Module["onReceive"](); });
EM_JS(void, gz_js_take, (uint8_t* dst), { HEAPU8.set(Module["takeReceived"](), dst); });

static cbmpc_error_t t_send(void*, int32_t, const uint8_t* data, int size) {
  gz_js_send(data, size);
  return CBMPC_SUCCESS;
}

static cbmpc_error_t t_receive(void*, int32_t, cmem_t* out) {
  int n = gz_js_receive();
  if (n < 0) return CBMPC_E_NET_GENERAL;
  uint8_t* p = (uint8_t*)malloc(n > 0 ? n : 1);
  if (!p) return CBMPC_E_GENERAL;
  gz_js_take(p);
  out->data = p;
  out->size = n;
  return CBMPC_SUCCESS;
}

static void t_free(void*, void* ptr) { free(ptr); }

static std::vector<uint8_t> g_out;
static void set_out(cmem_t m) {
  g_out.assign(m.data, m.data + (m.size > 0 ? m.size : 0));
  cbmpc_cmem_free(m);
}

static cbmpc_2pc_job_t job_for(int self, const char* p1, const char* p2, const cbmpc_transport_t* t) {
  cbmpc_2pc_job_t job = {self == 0 ? CBMPC_2PC_P1 : CBMPC_2PC_P2, p1, p2, t};
  return job;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE uint8_t* gz_out_ptr() { return g_out.data(); }
EMSCRIPTEN_KEEPALIVE int gz_out_size() { return (int)g_out.size(); }
EMSCRIPTEN_KEEPALIVE void gz_out_clear() {
  // Key material passes through here: wipe it, don't just drop it.
  if (!g_out.empty()) memset(g_out.data(), 0, g_out.size());
  g_out.clear();
}

/** Key generation on secp256k1. Output: this party's key blob. */
EMSCRIPTEN_KEEPALIVE int gz_ecdsa2p_dkg(int self, const char* p1, const char* p2) {
  cbmpc_transport_t t = {nullptr, t_send, t_receive, nullptr, t_free};
  cbmpc_2pc_job_t job = job_for(self, p1, p2, &t);
  cmem_t key = {nullptr, 0};
  cbmpc_error_t rv = cbmpc_ecdsa_2p_dkg(&job, CBMPC_CURVE_SECP256K1, &key);
  if (rv == CBMPC_SUCCESS) set_out(key);
  return rv;
}

/** Sign a 32-byte hash. Output: the DER signature on P1, nothing on P2. */
EMSCRIPTEN_KEEPALIVE int gz_ecdsa2p_sign(int self, const char* p1, const char* p2, const uint8_t* key, int key_size, const uint8_t* hash) {
  cbmpc_transport_t t = {nullptr, t_send, t_receive, nullptr, t_free};
  cbmpc_2pc_job_t job = job_for(self, p1, p2, &t);
  cmem_t sig = {nullptr, 0};
  cmem_t no_sid = {nullptr, 0};
  cbmpc_error_t rv = cbmpc_ecdsa_2p_sign(&job, cmem_t{(uint8_t*)key, key_size}, cmem_t{(uint8_t*)hash, 32}, no_sid, nullptr, &sig);
  if (rv == CBMPC_SUCCESS) set_out(sig);
  return rv;
}

/** Output: the joint public key, SEC1 compressed. */
EMSCRIPTEN_KEEPALIVE int gz_ecdsa2p_public_key(const uint8_t* key, int key_size) {
  cmem_t pub = {nullptr, 0};
  cbmpc_error_t rv = cbmpc_ecdsa_2p_get_public_key_compressed(cmem_t{(uint8_t*)key, key_size}, &pub);
  if (rv == CBMPC_SUCCESS) set_out(pub);
  return rv;
}

/** Output: this party's secret share x_i (big-endian; the key is x_1 + x_2 mod n). For hand-over to the egg only. */
EMSCRIPTEN_KEEPALIVE int gz_ecdsa2p_private_share(const uint8_t* key, int key_size) {
  cmem_t detached = {nullptr, 0}, scalar = {nullptr, 0};
  cbmpc_error_t rv = cbmpc_ecdsa_2p_detach_private_scalar(cmem_t{(uint8_t*)key, key_size}, &detached, &scalar);
  if (rv != CBMPC_SUCCESS) return rv;
  if (detached.data) memset(detached.data, 0, detached.size);
  cbmpc_cmem_free(detached);
  set_out(scalar);
  return rv;
}

}  // extern "C"
