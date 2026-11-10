/**
 * USDC on Base for hosting accounts (Fluence takes x402 USDC on Base): balances, the QUAI-to-USDC swap a hosting key
 * does after QUAI is bridged to it, and EIP-3009 authorization state (did a signed x402 payment settle?).
 * No Symbiosis here, so servers can import it cheaply (`@gremlins/treasury/base`).
 */
import { Contract, type Provider, type Signer } from 'ethers'
import { CHAIN, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN, USDC } from './constants.js'
import { gaslessSell } from './cow.js'

export const BASE_USDC = USDC[CHAIN.base]!
export const BASE_QUAI = QUAI_SYNTH[CHAIN.base]
const ERC20 = ['function balanceOf(address) view returns (uint256)']

export const usdcOnBase = async (provider: Provider, address: string): Promise<bigint> => new Contract(BASE_USDC, ERC20, provider).balanceOf(address)
/** Symbiosis-synthetic QUAI on Base, e.g. just bridged from Quai. */
export const quaiOnBase = async (provider: Provider, address: string): Promise<bigint> => new Contract(BASE_QUAI, ERC20, provider).balanceOf(address)

/** True once the EIP-3009 authorization (authorizer, nonce) was used on-chain: that payment happened. */
export const usdcAuthorizationUsed = async (provider: Provider, authorizer: string, nonce: string): Promise<boolean> =>
  new Contract(BASE_USDC, ['function authorizationState(address,bytes32) view returns (bool)'], provider).authorizationState(authorizer, nonce)

/** Sell QUAI held on Base for USDC to the same address on CoW. Gasless: QUAI's permit pays for the approval. */
export const sellQuaiOnBaseForUsdc = (o: { signer: Signer; provider: Provider; amount: bigint; appCode?: string }) =>
  gaslessSell({ signer: o.signer, provider: o.provider, chainId: CHAIN.base, sellToken: BASE_QUAI, sellTokenPermitDomain: QUAI_SYNTH_PERMIT_DOMAIN, buyToken: BASE_USDC, amount: o.amount, appCode: o.appCode ?? 'gremlins-egg' })
