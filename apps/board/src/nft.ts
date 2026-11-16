/**
 * NFT avatars: is this token owned by this address, and what does it look like?
 *
 * Ownership is read on-chain through a public JSON-RPC endpoint per chain: ERC-721 `ownerOf(id)`, and ERC-1155
 * `balanceOf(owner, id)` when the contract isn't a 721. The picture comes from `tokenURI` / `uri` metadata: ipfs://
 * and ar:// go through public gateways, other URLs must be https on port 443 to a public address (no redirects into
 * private networks), JSON and images are size- and time-capped, and only raster images are taken (avatar-image.ts
 * re-encodes them; SVG is refused, never rendered).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { AbiCoder, Interface, getAddress } from 'ethers'
import type { NftChain, NftRef } from './store.ts'

export const NFT_CHAINS: readonly NftChain[] = ['ethereum', 'base', 'quai']
export const NFT_CHAIN_LABEL: Record<NftChain, string> = { ethereum: 'Ethereum', base: 'Base', quai: 'Quai' }

const MAX_METADATA_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 10_000

export class NftError extends Error {
  readonly status: 400 | 403 | 415 | 502
  constructor(status: 400 | 403 | 415 | 502, message: string) {
    super(message)
    this.status = status
  }
}

/** The RPC answered with a revert (the call itself failed), as opposed to the RPC being unreachable. */
class Reverted extends Error {}

const ABI = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function uri(uint256 id) view returns (string)',
])

/** Fetches a URL's bytes (at most `maxBytes`). Injectable for tests; the default refuses private networks. */
export type ByteGetter = (url: string, maxBytes: number) => Promise<Uint8Array>

export interface NftOptions {
  rpc: Partial<Record<NftChain, string>>
  ipfsGateway: string
  /** JSON-RPC transport (defaults to global fetch). */
  fetch?: typeof fetch
  /** Metadata and image downloads (defaults to safeHttpsGet). */
  get?: ByteGetter
}

export class NftVerifier {
  private readonly o: NftOptions
  private id = 0
  constructor(o: NftOptions) {
    this.o = o
  }

  /** The chains with an RPC configured. */
  chains(): NftChain[] {
    return NFT_CHAINS.filter((c) => !!this.o.rpc[c])
  }

  private async call(chain: NftChain, to: string, data: string): Promise<string> {
    const url = this.o.rpc[chain]
    if (!url) throw new NftError(400, `NFT avatars on ${NFT_CHAIN_LABEL[chain]} are not available here`)
    const f = this.o.fetch ?? fetch
    let res: Response
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Quai's RPC names its methods quai_*; the call itself is the same.
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method: chain === 'quai' ? 'quai_call' : 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new NftError(502, `the ${NFT_CHAIN_LABEL[chain]} RPC did not answer`)
    }
    if (!res.ok) throw new NftError(502, `the ${NFT_CHAIN_LABEL[chain]} RPC answered ${res.status}`)
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } } | null
    if (!j) throw new NftError(502, `the ${NFT_CHAIN_LABEL[chain]} RPC sent something unreadable`)
    if (j.error) {
      // Execution reverted (code 3, or -32000 with a revert message): the contract said no. Anything else is the RPC.
      if (j.error.code === 3 || /revert|invalid opcode/i.test(j.error.message ?? '')) throw new Reverted(j.error.message ?? 'reverted')
      throw new NftError(502, `the ${NFT_CHAIN_LABEL[chain]} RPC failed: ${String(j.error.message ?? 'error').slice(0, 120)}`)
    }
    if (typeof j.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(j.result)) throw new NftError(502, `the ${NFT_CHAIN_LABEL[chain]} RPC sent a malformed result`)
    // A call to an address with no code returns 0x: treat it like a revert.
    if (j.result === '0x') throw new Reverted('no contract')
    return j.result
  }

  /**
   * Who owns the token, by the standard the contract answers to. `standard` skips detection (rechecks). A 721 whose
   * ownerOf reverts (burned, or never minted) is not owned; RPC trouble throws NftError(502) so callers can retry.
   */
  async ownership(ref: { chain: NftChain; contract: string; tokenId: string; standard?: NftRef['standard'] }, owner: string): Promise<{ owned: boolean; standard: NftRef['standard'] }> {
    const contract = normAddress(ref.contract)
    const id = BigInt(ref.tokenId)
    const try721 = async () => {
      const out = await this.call(ref.chain, contract, ABI.encodeFunctionData('ownerOf', [id]))
      const [who] = ABI.decodeFunctionResult('ownerOf', out)
      return (who as string).toLowerCase() === owner.toLowerCase()
    }
    const try1155 = async () => {
      const out = await this.call(ref.chain, contract, ABI.encodeFunctionData('balanceOf', [normAddress(owner), id]))
      const [bal] = ABI.decodeFunctionResult('balanceOf', out)
      return (bal as bigint) > 0n
    }
    const decodeFail = (e: unknown) => e instanceof Reverted || (e instanceof Error && !(e instanceof NftError))
    if (ref.standard === 'erc721') {
      try { return { owned: await try721(), standard: 'erc721' } } catch (e) { if (decodeFail(e)) return { owned: false, standard: 'erc721' }; throw e }
    }
    if (ref.standard === 'erc1155') {
      try { return { owned: await try1155(), standard: 'erc1155' } } catch (e) { if (decodeFail(e)) return { owned: false, standard: 'erc1155' }; throw e }
    }
    try {
      return { owned: await try721(), standard: 'erc721' }
    } catch (e) {
      if (!decodeFail(e)) throw e
    }
    try {
      return { owned: await try1155(), standard: 'erc1155' }
    } catch (e) {
      if (!decodeFail(e)) throw e
    }
    throw new NftError(400, 'that token was not found: the contract answers neither as ERC-721 (ownerOf) nor as ERC-1155 (balanceOf)')
  }

  /** The token's picture, as raw bytes (not yet decoded: avatar-image.ts does that). */
  async image(ref: NftRef): Promise<Uint8Array> {
    const contract = normAddress(ref.contract)
    const id = BigInt(ref.tokenId)
    let uri: string
    try {
      const fn = ref.standard === 'erc721' ? 'tokenURI' : 'uri'
      const out = await this.call(ref.chain, contract, ABI.encodeFunctionData(fn, [id]))
      uri = ABI.decodeFunctionResult(fn, out)[0] as string
    } catch (e) {
      if (e instanceof NftError) throw e
      throw new NftError(400, "the contract didn't give a metadata URI for this token")
    }
    // ERC-1155: {id} is the token id as 64 lowercase hex digits.
    if (ref.standard === 'erc1155') uri = uri.replaceAll('{id}', id.toString(16).padStart(64, '0'))
    const metaBytes = await this.fetchUri(uri.trim(), MAX_METADATA_BYTES, 'json')
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(Buffer.from(metaBytes).toString('utf8'))
    } catch {
      throw new NftError(400, "the token's metadata isn't JSON")
    }
    const img = [meta.image, meta.image_url].find((x) => typeof x === 'string' && x.trim()) as string | undefined
    if (!img) throw new NftError(400, typeof meta.image_data === 'string' ? "this token's picture is inline SVG, which isn't supported" : 'the token has no image')
    return this.fetchUri(img.trim(), MAX_IMAGE_BYTES, 'image')
  }

  /** Resolves ipfs://, ar://, data: and https: URIs; anything else is refused. */
  private async fetchUri(uri: string, maxBytes: number, what: 'json' | 'image'): Promise<Uint8Array> {
    if (uri.startsWith('data:')) {
      const m = /^data:([a-z0-9.+/-]+)?(?:;[a-z0-9=.-]+)*?(;base64)?,(.*)$/is.exec(uri)
      if (!m) throw new NftError(400, 'malformed data: URI in the token metadata')
      const mime = (m[1] ?? '').toLowerCase()
      if (what === 'image' && mime.includes('svg')) throw new NftError(415, "this token's picture is SVG, which isn't supported")
      if (what === 'json' && mime && !mime.includes('json')) throw new NftError(400, 'the token metadata is not JSON')
      const bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8')
      if (bytes.byteLength > maxBytes) throw new NftError(400, `the token's ${what === 'json' ? 'metadata' : 'picture'} is too large`)
      return new Uint8Array(bytes)
    }
    const url = this.resolve(uri)
    try {
      return await (this.o.get ?? safeHttpsGet)(url, maxBytes)
    } catch (e) {
      throw new NftError(502, `could not fetch the token's ${what === 'json' ? 'metadata' : 'picture'}: ${(e as Error).message}`)
    }
  }

  resolve(uri: string): string {
    const gw = this.o.ipfsGateway
    let m: RegExpExecArray | null
    if ((m = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+(?:\/[^?#]*)?)$/.exec(uri))) return gw + m[1]
    if ((m = /^ar:\/\/([A-Za-z0-9_-]{43}(?:\/[^?#]*)?)$/.exec(uri))) return `https://arweave.net/${m[1]}`
    // Plain gateway links work as they are; https only.
    let u: URL
    try {
      u = new URL(uri)
    } catch {
      throw new NftError(400, 'the token metadata points at something that is not a URL')
    }
    if (u.protocol !== 'https:') throw new NftError(400, 'the token metadata must be on https, IPFS or Arweave')
    if (u.username || u.password) throw new NftError(400, 'the token metadata URL carries credentials')
    if (u.port && u.port !== '443') throw new NftError(400, 'the token metadata must be on the standard https port')
    return u.toString()
  }
}

/** Accepts any-case 0x addresses (EIP-55 checksums are not required from people pasting them). */
export function normAddress(a: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new NftError(400, 'contract must be a 0x address')
  return getAddress(a.toLowerCase())
}

// ── outbound fetches that can't reach private networks ───────────────────────

const PRIVATE = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) PRIVATE.addSubnet(net, bits, 'ipv6')

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip)
  if (!v) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return !PRIVATE.check(mapped[1]!, 'ipv4')
  return !PRIVATE.check(ip, v === 4 ? 'ipv4' : 'ipv6')
}

/** DNS lookup that fails for names resolving to loopback, private, link-local or other non-public addresses. */
function publicLookup(hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '')
    const list = addrs as LookupAddress[]
    if (!list.length || list.some((a) => !isPublicIp(a.address))) return cb(new Error(`${hostname} is not a public address`), '')
    if ((options as { all?: boolean }).all) return cb(null, list)
    cb(null, list[0]!.address, list[0]!.family)
  })
}

/**
 * GET over https to public addresses only, at most `maxBytes`, 10 s overall, following up to 3 redirects (each one
 * checked again). Not for anything but fetching NFT metadata and pictures.
 */
export function safeHttpsGet(url: string, maxBytes: number, redirects = 3): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return reject(new Error('only https on port 443'))
    if (isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('not a public address'))
    const req = request(u, { method: 'GET', lookup: publicLookup as never, timeout: TIMEOUT_MS, headers: { accept: 'application/json, image/*;q=0.9, */*;q=0.1', 'user-agent': 'gremlinz-board/1 (+https://gremlinz.ai)' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('too many redirects'))
        let next: string
        try { next = new URL(res.headers.location, u).toString() } catch { return reject(new Error('bad redirect')) }
        return safeHttpsGet(next, maxBytes, redirects - 1).then(resolve, reject)
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${status}`))
      }
      const declared = Number(res.headers['content-length'] ?? 0)
      if (declared > maxBytes) {
        res.destroy()
        return reject(new Error('too large'))
      }
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (c: Buffer) => {
        n += c.length
        if (n > maxBytes) {
          res.destroy()
          reject(new Error('too large'))
        } else chunks.push(c)
      })
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
      res.on('error', reject)
    })
    const overall = setTimeout(() => req.destroy(new Error('timed out')), TIMEOUT_MS)
    req.on('close', () => clearTimeout(overall))
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

/** The ABI coder, for tests that play an RPC. */
export const nftAbi = { iface: ABI, coder: AbiCoder.defaultAbiCoder() }
