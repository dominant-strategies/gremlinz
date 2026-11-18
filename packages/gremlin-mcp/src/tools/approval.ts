import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyMessage } from 'ethers'
import { verifySignedConfig, type SignedConfig } from '@gremlins/hatch'
import { writeDurable } from '@gremlins/hatch/node'
import { z } from 'zod'
import { boardUrl, homeFile, keys } from '../env.js'

const LIFETIME_MS = 20 * 60_000

export const MakerApproval = z.object({
  nonce: z.string().uuid(),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
})

type Approval = z.infer<typeof MakerApproval>
type Action = 'wallet_send' | 'move_out' | 'hashference_topup' | 'inference_connect' | 'inference_remove'
export type Approve = (action: Action, fields: Record<string, string>, approval?: Approval) => string | undefined

export function approvalText(maker: string, gremlin: string, action: Action, fields: Record<string, string>, nonce: string, expiresAt: number) {
  return [
    'Gremlinz maker approval v1',
    `Maker: ${maker.toLowerCase()}`,
    `Gremlin: ${gremlin.toLowerCase()}`,
    `Action: ${action}`,
    ...Object.keys(fields).sort().map(key => `${key}: ${JSON.stringify(fields[key])}`),
    `Nonce: ${nonce}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,
  ].join('\n')
}

export function makerApproval(dir: string, maker: string, gremlin: string, now: () => number = Date.now): Approve {
  return (action, fields, approval) => {
    const t = now()
    if (!approval) {
      const nonce = randomUUID()
      const expiresAt = t + LIFETIME_MS
      const message = approvalText(maker, gremlin, action, fields, nonce, expiresAt)
      return `Maker approval required. Refer this exact action to the maker for a wallet message signature (personal_sign). Retry with the same arguments and approval {nonce, expiresAt, signature}.\nNonce: ${nonce}\nExpires at (millisecond timestamp): ${expiresAt}\n\n${message}`
    }
    if (!MakerApproval.safeParse(approval).success || approval.expiresAt <= t || approval.expiresAt > t + LIFETIME_MS) return 'The maker approval is invalid or expired.'
    try {
      if (verifyMessage(approvalText(maker, gremlin, action, fields, approval.nonce, approval.expiresAt), approval.signature).toLowerCase() !== maker.toLowerCase()) return 'The signature does not approve this action as the maker.'
    } catch { return 'The signature does not approve this action as the maker.' }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // Consume before any side effect, including across crashes and concurrent tool calls.
      writeDurable(join(dir, approval.nonce.toLowerCase()), String(approval.expiresAt), { exclusive: true })
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'This maker approval has already been used.' : 'Could not record the maker approval. The action was blocked.'
    }
  }
}

export const requireMakerApproval: Approve = (action, fields, approval) => {
  try {
    const signed = JSON.parse(readFileSync(homeFile('signed-config.json'), 'utf8')) as SignedConfig
    const gremlin = keys()
    const maker = signed.message.maker
    const checked = verifySignedConfig(signed, { maker, configHash: signed.message.configHash, gremlin: gremlin.quai.address })
    if (checked.ok) {
      const response = makerApproval(homeFile('maker-approvals'), maker, gremlin.evm.address)(action, fields, approval)
      if (!approval && response) return `Maker review page: ${new URL('/approve', boardUrl())}.\n${response}`
      return response
    }
  } catch { /* Unknown or unreadable maker identity fails closed. */ }
  return 'The maker identity could not be verified. The action was blocked.'
}
