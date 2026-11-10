/**
 * Quai Smart Wallet accounts: Safe 1.4.1 proxies on Quai mainnet (chain 9). A Safe has no key, so its signature is
 * checked by asking the Safe (ERC-1271) instead of recovering an address.
 *
 * What the wallet signs, and what we ask the Safe: the dApp sends the plain message (our request payload); the wallet
 * host builds the SDK's `accountMessageRequest(chainId, safe, message)` = `safeMessageRequest(chainId, safe,
 * hashMessage(message))`, an EIP-712 `SafeMessage { bytes message }` over the 32-byte EIP-191 hash, domain
 * { chainId: 9, verifyingContract: safe }. The owner signs that digest with personal_sign and the host returns it with
 * v + 4 (Safe's eth_sign signature type). On chain, the CompatibilityFallbackHandler's
 * `isValidSignature(bytes32 dataHash, bytes sig)` wraps dataHash the same way (`getMessageHash(abi.encode(dataHash))`,
 * the same SafeMessage typed hash) and calls `checkSignatures`, which reverts on a bad signature and otherwise returns
 * 0x1626ba7e. So we call `isValidSignature(hashMessage(payload), sig)` on the Safe. Checked on mainnet: the handler's
 * `getMessageHash(hashMessage(m))` equals the SDK's SafeMessage hash, and a wrong signature reverts with GS026.
 *
 * Only contracts whose runtime code hash is a pinned Quai Smart Wallet proxy are asked: anything else (an EOA, an
 * arbitrary contract that answers yes to everything) is not a smart account. Every proxy shares that runtime, and a
 * proxy can only speak for its own address, so this does not let one account sign for another.
 */
import { getAddress, hashMessage, keccak256 } from 'ethers'

/** Runtime code hash of the Quai Smart Wallet Safe proxy (factories 0x000Bc438… and 0x00050f80…). */
export const QUAI_SMART_WALLET_CODE_HASHES = ['0x9700e0d224b2a96ebcd150bd8259e72248eaf0a2d2abcdbee3898a36f652e3b1']
/** Quai Smart Wallet Safes live in cyprus1 (0x00… addresses). */
export const DEFAULT_QUAI_RPC = 'https://rpc.quai.network/cyprus1'

const ERC1271_MAGIC = '0x1626ba7e'
const IS_VALID_SIGNATURE = '0x1626ba7e' // isValidSignature(bytes32,bytes)
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

export interface AccountSignatureChecker {
  /** Does `address` (a smart account) accept `signature` over the EIP-191 message `message`? Never throws. */
  isValidSignature(address: string, message: string, signature: string): Promise<boolean>
}

export interface SmartAccountOptions {
  rpcUrl?: string
  /** Accepted proxy runtime code hashes. */
  codeHashes?: string[]
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  /** How long a "this is a smart account" answer is kept: proxies are immutable, so long. */
  positiveTtlMs?: number
  /** How long a "not a smart account" answer is kept: short, since a Safe can be deployed at a counterfactual address. */
  negativeTtlMs?: number
  maxCached?: number
}

/**
 * One Safe owner signature in canonical form: 65 bytes, ECDSA (v 27/28, or 31/32 for eth_sign), low s. The Safe would
 * also take a high-s twin or extra trailing bytes, which would be a fresh replay key for the same signed request.
 */
function canonicalOwnerSignature(sig: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false
  const r = BigInt('0x' + sig.slice(2, 66))
  const s = BigInt('0x' + sig.slice(66, 130))
  const v = parseInt(sig.slice(130, 132), 16)
  return [27, 28, 31, 32].includes(v) && r > 0n && s > 0n && s <= HALF_N
}

export class SmartAccountVerifier implements AccountSignatureChecker {
  private readonly rpcUrl: string
  private readonly codeHashes: Set<string>
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly positiveTtlMs: number
  private readonly negativeTtlMs: number
  private readonly maxCached: number
  private readonly cache = new Map<string, { smart: boolean; until: number }>()
  private id = 0

  constructor(o: SmartAccountOptions = {}) {
    this.rpcUrl = o.rpcUrl ?? DEFAULT_QUAI_RPC
    this.codeHashes = new Set((o.codeHashes ?? QUAI_SMART_WALLET_CODE_HASHES).map((h) => h.toLowerCase()))
    this.fetch = o.fetch ?? ((...a) => fetch(...a))
    this.now = o.now ?? Date.now
    this.timeoutMs = o.timeoutMs ?? 8000
    this.positiveTtlMs = o.positiveTtlMs ?? 24 * 3600_000
    this.negativeTtlMs = o.negativeTtlMs ?? 60_000
    this.maxCached = o.maxCached ?? 10_000
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`Quai RPC answered ${res.status}`)
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } }
    if (j.error || j.result === undefined) throw Object.assign(new Error(`Quai RPC: ${j.error?.message ?? 'no result'}`), { rpcError: j.error })
    return j.result
  }

  /** Is this address a pinned Quai Smart Wallet proxy? Throws when the chain can't be asked (nothing is cached then). */
  async isSmartAccount(address: string): Promise<boolean> {
    const key = address.toLowerCase()
    const hit = this.cache.get(key)
    if (hit && hit.until > this.now()) return hit.smart
    // Quai's RPC rejects addresses without a valid EIP-55 checksum, all-lowercase included.
    const code = await this.rpc('quai_getCode', [getAddress(address), 'latest'])
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error('Quai RPC: malformed code')
    const smart = code !== '0x' && this.codeHashes.has(keccak256(code))
    this.cache.delete(key)
    if (this.cache.size >= this.maxCached) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, { smart, until: this.now() + (smart ? this.positiveTtlMs : this.negativeTtlMs) })
    return smart
  }

  async isValidSignature(address: string, message: string, signature: string): Promise<boolean> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !canonicalOwnerSignature(signature)) return false
    try {
      if (!(await this.isSmartAccount(address))) return false
      const data = IS_VALID_SIGNATURE
        + hashMessage(message).slice(2)
        + (64).toString(16).padStart(64, '0') // offset of the bytes argument
        + (65).toString(16).padStart(64, '0') // its length
        + signature.slice(2).toLowerCase().padEnd(192, '0') // 65 bytes, padded to 96
      const out = await this.rpc('quai_call', [{ to: getAddress(address), data }, 'latest'])
      // bytes4 magic, ABI-padded to one word. A bad signature reverts (an RPC error), which also lands in catch.
      return typeof out === 'string' && out.length === 66 && out.slice(0, 10).toLowerCase() === ERC1271_MAGIC && /^0+$/.test(out.slice(10))
    } catch {
      return false // fail closed: no answer from the chain is not a yes
    }
  }
}
