import { describe, expect, it } from 'vitest'
import { devBalances } from '../src/dev.js'

describe('pretend balances', () => {
  const env = { GREMLIN_DEV_BALANCES: '{"quai:9":"1000"}' }
  it('apply only with a local board', async () => {
    expect(await devBalances(env, () => 'http://localhost:8787')!.read({ quai: '', evm: '' })).toEqual({ 'quai:9': 1000n })
    expect(devBalances(env, () => 'https://gremlinz.ai')).toBeUndefined()
    expect(devBalances({}, () => 'http://localhost:8787')).toBeUndefined()
  })
})
