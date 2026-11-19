/**
 * lent_keys: the API keys people have lent this gremlin, as its gateway holds them: provider and its rules, models,
 * the lender's budget rules and wishes, what is left to use this period, and whether a key is resting or stopped.
 * Read from the gateway's localhost admin endpoint; keys themselves never leave the gateway.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { policyLines } from '@gremlins/hatch'
import type { LentKeyStatus } from '../gateway/grants.js'
import { untrusted } from '../board.js'
import { fail, text } from '../result.js'

export interface LentDeps { fetch?: typeof fetch; adminUrl?: string }

export function describeLent(grants: LentKeyStatus[]): string {
  if (!grants.length) return 'Nobody has lent you an API key yet. People can lend you spare capacity from your page on the board ("Lend capacity").'
  return grants.map((g) => {
    const a = g.allowance
    const lim = g.limiter
    const state = lim.disabled ? `STOPPED for good: ${lim.disabled.reason}. The lender has been told.`
      : lim.restingUntil ? `resting until ${lim.restingUntil} (${lim.restingBecause})`
      : a.allowedUsd > 0 ? `usable now: $${a.allowedUsd.toFixed(4)} left to use before ${a.resetsAt}` : `not usable now: ${a.reason}; next reset ${a.resetsAt}`
    const lines = [
      `## ${g.provider.name}, lent by ${g.lender} (grant ${g.grantId})`,
      `State: ${state}`,
      `Models: ${g.models.join(', ')}. Used this period: $${a.usedThisPeriodUsd.toFixed(4)}${g.remainingOnKeyUsd !== null ? `; the provider says $${g.remainingOnKeyUsd.toFixed(2)} is left on the key` : ''}.`,
      `Rate limits for you on this key: ${lim.limits.rpm} requests/min${lim.limits.tpm ? `, ${lim.limits.tpm} tokens/min` : ''}${lim.limits.rpd ? `, ${lim.limits.rpd} requests/day` : ''}, ${lim.limits.concurrency} at a time. Your gateway enforces them.`,
      'The lender\'s rules (enforced by your gateway):', ...policyLines(g.policy).map((l) => `- ${l.replace(/^Your budget/, 'Their budget').replace(/^It may/, 'You may')}`),
      `Repayment: ${g.repay === 'patron' ? 'credit them as a patron' : 'buy them syndicate shares out of income'}.`,
    ]
    if (g.provider.obligations.length) lines.push(`${g.provider.name}'s rules you must keep with this key: ${g.provider.obligations.join(' ')}`)
    if (g.provider.conditions.length) lines.push(`The lender accepted: ${g.provider.conditions.join(' ')}`)
    lines.push(g.wishes ? untrusted('LENDER WISHES', g.wishes) : 'No wishes: use it for anything that keeps to your rules.')
    return lines.join('\n')
  }).join('\n\n')
}

export function registerLentTools(server: McpServer, deps: LentDeps = {}) {
  const admin = deps.adminUrl ?? process.env.GREMLIN_GATEWAY_ADMIN ?? 'http://127.0.0.1:8711'
  server.registerTool('lent_keys', {
    description:
      'See lent inference providers, models, remaining allowances, rate limits and lender wishes. The gateway uses lent keys to draft within those limits. A configured trusted provider reviews the draft and produces the reply or tool calls. Honour lender wishes and plan work around their allowance windows.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const r = await (deps.fetch ?? fetch)(`${admin}/admin/lent`, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) return fail(`Your gateway did not answer (${r.status}).`)
      return text(describeLent(((await r.json()) as { grants: LentKeyStatus[] }).grants))
    } catch (e) {
      return fail(`Could not reach your gateway: ${(e as Error).message.slice(0, 200)}`)
    }
  })
}
