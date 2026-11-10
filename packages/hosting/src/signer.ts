/**
 * Who signs for a hosting account. On Fluence the paying wallet *is* the account: x402 top-ups need EIP-712 typed data
 * (EIP-3009 transferWithAuthorization), sign-in needs a personal_sign (SIWE). Nothing else is asked of the key.
 *
 * Today the hatch backend holds the whole key (`localSigner`) until it seals it to the egg. Before launch this becomes a
 * 2-of-2 multiparty signer (browser shard + backend shard, e.g. DKLs23) behind this same interface, so neither the
 * maker nor we can sign alone: keep callers to these three members.
 */
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

export interface TypedDataToSign {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface HostingSigner {
  readonly address: Hex
  signMessage(message: string): Promise<Hex>
  signTypedData(typedData: TypedDataToSign): Promise<Hex>
}

export function localSigner(privateKey: Hex): HostingSigner {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (td) => account.signTypedData(td as never),
  }
}
