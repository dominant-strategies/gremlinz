/**
 * Coinbase's cb-mpc 2-party ECDSA (secp256k1), built to WebAssembly by cbmpc/build.sh, for Node and the browser.
 *
 * cb-mpc runs a protocol as one call that blocks on its transport. Each run gets its own module instance whose
 * `receive` suspends (Asyncify) until the peer's next messages are delivered with `step()`; `step()` returns what this
 * party sends next, once it waits again or has finished. Messages are opaque bytes; protocol state stays in the
 * instance (in memory only), so a lost run is simply started again.
 */
import createCbmpc, { type CbmpcModule } from '../cbmpc/wasm/cbmpc.mjs'

const WASM_URL = new URL('../cbmpc/wasm/cbmpc.wasm', import.meta.url)
let compiled: Promise<WebAssembly.Module> | undefined

/** Compile once per process; every run instantiates its own copy (own memory, own suspended stack). */
function wasmModule(): Promise<WebAssembly.Module> {
  return (compiled ??= (async () => {
    const isNode = typeof process !== 'undefined' && !!process.versions?.node && WASM_URL.protocol === 'file:'
    let bytes: ArrayBuffer | Uint8Array
    if (isNode) {
      const fs = 'node:fs/promises' // not a static import: keeps bundlers from pulling fs into the browser build
      bytes = await ((await import(/* @vite-ignore */ fs)) as typeof import('node:fs/promises')).readFile(WASM_URL)
    } else {
      const res = await fetch(WASM_URL)
      if (!res.ok) throw new Error(`cb-mpc WebAssembly: ${res.status}`)
      bytes = await res.arrayBuffer()
    }
    return WebAssembly.compile(bytes as BufferSource)
  })())
}

async function instance(hooks: { onSend?: (m: Uint8Array) => void; onReceive?: () => number | Promise<number>; takeReceived?: () => Uint8Array } = {}): Promise<CbmpcModule> {
  const mod = await wasmModule()
  return createCbmpc({
    ...hooks,
    instantiateWasm: (imports, done) => {
      void WebAssembly.instantiate(mod, imports).then((i) => done(i, mod))
      return {}
    },
  })
}

/** A failed cb-mpc call. `bitLeak`: cb-mpc's E_ECDSA_2P_BIT_LEAK (only its global-abort signing, which we don't use). */
export class CbmpcError extends Error {
  readonly code: number
  constructor(what: string, code: number) {
    super(`cb-mpc ${what} failed (0x${(code >>> 0).toString(16)})`)
    this.code = code >>> 0
  }
  get bitLeak() {
    return this.code === 0xff040002
  }
}

const copyOut = (m: CbmpcModule): Uint8Array => {
  const out = m.HEAPU8.slice(m._gz_out_ptr(), m._gz_out_ptr() + m._gz_out_size())
  m._gz_out_clear()
  return out
}

const put = (m: CbmpcModule, bytes: Uint8Array): number => {
  const p = m._malloc(Math.max(1, bytes.length))
  m.HEAPU8.set(bytes, p)
  return p
}

export interface Parties {
  /** 0: party 1 (the board), 1: party 2 (the maker's page). */
  self: 0 | 1
  /** Globally unique names of party 1 and party 2 (cb-mpc derives its party ids from them). */
  p1: string
  p2: string
}

export type StepResult<T> = { out: Uint8Array[]; done: false } | { out: Uint8Array[]; done: true; result: T }

/** One protocol run, driven by the caller's relay. */
export class CbmpcRun<T> {
  private inbox: Uint8Array[] = []
  private outbox: Uint8Array[] = []
  private taken: Uint8Array = new Uint8Array()
  private waiting: ((n: number) => void) | null = null
  private wake: (() => void) | null = null
  private finished: { ok: true; value: T } | { ok: false; error: Error } | null = null
  private started = false
  private cancelled = false

  private constructor(private run: (m: CbmpcModule) => Promise<T>) {}

  /** Key generation on secp256k1; the result is this party's key blob (secret: a key share). */
  static dkg(p: Parties): CbmpcRun<Uint8Array> {
    return new CbmpcRun(async (m) => {
      const [a, b] = [m.stringToNewUTF8(p.p1), m.stringToNewUTF8(p.p2)]
      try {
        const rv = (await m.ccall('gz_ecdsa2p_dkg', 'number', ['number', 'number', 'number'], [p.self, a, b], { async: true })) as number
        if (rv) throw new CbmpcError('key generation', rv)
        return copyOut(m)
      } finally {
        m._free(a)
        m._free(b)
      }
    })
  }

  /** Sign a 32-byte hash; the result is the DER signature on party 1, null on party 2. */
  static sign(p: Parties, key: Uint8Array, hash: Uint8Array): CbmpcRun<Uint8Array | null> {
    if (hash.length !== 32) throw new Error('sign a 32-byte hash')
    return new CbmpcRun(async (m) => {
      const [a, b, k, h] = [m.stringToNewUTF8(p.p1), m.stringToNewUTF8(p.p2), put(m, key), put(m, hash)]
      try {
        const rv = (await m.ccall('gz_ecdsa2p_sign', 'number', ['number', 'number', 'number', 'number', 'number', 'number'], [p.self, a, b, k, key.length, h], { async: true })) as number
        if (rv) throw new CbmpcError('signing', rv)
        const sig = copyOut(m)
        return sig.length ? sig : null
      } finally {
        m.HEAPU8.fill(0, k, k + key.length)
        for (const ptr of [a, b, k, h]) m._free(ptr)
      }
    })
  }

  /**
   * Deliver the peer's messages (none to start a party that speaks first). Resolves with this party's outgoing
   * messages once it waits for more, or with its result once it has finished.
   */
  async step(incoming: Uint8Array[]): Promise<StepResult<T>> {
    if (this.finished) throw new Error('protocol run already finished')
    this.inbox.push(...incoming)
    const idle = new Promise<void>((r) => (this.wake = r))
    if (!this.started) {
      this.started = true
      const m = await instance({
        onSend: (msg) => void this.outbox.push(msg),
        onReceive: () => {
          if (this.cancelled) return -1
          const next = this.inbox.shift()
          if (next) return this.take(next)
          return new Promise<number>((res) => {
            this.waiting = res
            this.wake?.()
          })
        },
        takeReceived: () => this.taken,
      })
      this.run(m).then(
        (value) => { this.finished = { ok: true, value } },
        (error: Error) => { this.finished = { ok: false, error } },
      ).finally(() => this.wake?.())
    } else if (this.waiting && this.inbox.length) {
      const w = this.waiting
      this.waiting = null
      w(this.take(this.inbox.shift()!))
    } else if (this.waiting) this.wake?.() // nothing new: still waiting
    await idle
    const out = this.outbox.splice(0)
    const f = this.finished as { ok: true; value: T } | { ok: false; error: Error } | null
    if (!f) return { out, done: false }
    if (!f.ok) throw f.error
    return { out, done: true, result: f.value }
  }

  /** Abandon the run: a suspended receive fails and the instance is dropped. */
  cancel() {
    this.cancelled = true
    const w = this.waiting
    this.waiting = null
    w?.(-1)
  }

  private take(m: Uint8Array): number {
    this.taken = m
    return m.length
  }
}

let util: Promise<CbmpcModule> | undefined
const withKey = async (fn: string, key: Uint8Array): Promise<Uint8Array> => {
  const m = await (util ??= instance())
  const k = put(m, key)
  try {
    const rv = m.ccall(fn, 'number', ['number', 'number'], [k, key.length]) as number
    if (rv) throw new CbmpcError(fn, rv)
    return copyOut(m)
  } finally {
    m.HEAPU8.fill(0, k, k + key.length)
    m._free(k)
  }
}

/** The joint public key of a key blob, SEC1 compressed. */
export const cbmpcPublicKey = (key: Uint8Array) => withKey('gz_ecdsa2p_public_key', key)
/** This party's secret share x_i of a key blob (big-endian); the key is x_1 + x_2 mod n. Only for sealing to the egg. */
export const cbmpcPrivateShare = (key: Uint8Array) => withKey('gz_ecdsa2p_private_share', key)
