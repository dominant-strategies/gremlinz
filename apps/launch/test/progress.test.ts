import { describe, expect, it } from 'vitest'
import { FLUENCE_STEPS, Progress, SPORESTACK_STEPS, type StepState } from '../src/progress.js'

const make = () => {
  let saved: Record<string, StepState> | undefined
  const p = new Progress({ load: () => saved, save: (s) => { saved = JSON.parse(JSON.stringify(s)) } }, () => 'Hatching sprocket')
  return { p, saved: () => saved }
}

describe('hatch progress', () => {
  it('counts the signatures each plan needs', () => {
    expect(FLUENCE_STEPS.reduce((a, d) => a + d.sigs, 0)).toBe(6) // connect 1 + egg key 1 + wrap/approve/bridge 3 + config 1
    expect(SPORESTACK_STEPS.reduce((a, d) => a + d.sigs, 0)).toBe(2)
  })

  it('tracks a payment step through signatures, transactions and confirmation, and persists it', () => {
    const { p, saved } = make()
    const fund = p.step('fund-egg')
    fund.signing('Confirm "Wrap QUAI" in Pelagus (1 of 3)')
    expect(saved()!['fund-egg'].status).toBe('signing')
    fund.signed()
    fund.tx('quai', '0xabc', 'Wrap QUAI')
    fund.waiting('waiting for confirmation')
    fund.tx('quai', '0xabc', 'Wrap QUAI', 'confirmed')
    const st = saved()!['fund-egg']
    expect(st.sigsDone).toBe(1)
    expect(st.txs).toEqual([{ chain: 'quai', hash: '0xabc', label: 'Wrap QUAI', state: 'confirmed' }])
    expect(st.lastCheckAt).toBeTypeOf('number')
    fund.done()
    expect(p.isDone('fund-egg')).toBe(true)
  })

  it('resumes from saved state and records failures', () => {
    const { p, saved } = make()
    p.step('bridge').waiting('relaying')
    const q = new Progress({ load: () => saved(), save: () => {} }, () => 'x')
    expect(q.state('bridge').status).toBe('waiting')
    q.step('bridge').fail(new Error('bridge stuck'))
    expect(q.state('bridge')).toMatchObject({ status: 'failed', error: 'bridge stuck' })
  })

  it('skipped steps count as finished', () => {
    const { p } = make()
    for (const id of ['fund-egg', 'bridge', 'swap']) p.step(id).skip('egg key already holds USDC')
    expect(['fund-egg', 'bridge', 'swap'].every((id) => p.isDone(id))).toBe(true)
  })
})
