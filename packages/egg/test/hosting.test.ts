import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Wallet, hexlify, randomBytes } from 'ethers'
import { combineShards, hatchProof, sealBrowserShard, sealHostingHandover, type BrowserShard, type HatchClaim, type HostingHandover, type HostingShardHandover, type Sealed } from '@gremlins/hatch'
import type { FluenceCleanupReport } from '@gremlins/hosting'
import { generatePhrase, keysFromPhrase } from '../src/keys.js'
import { hostingFileStore, hostingStep, type HostingDeps, type HostingFile } from '../src/hosting.js'

const HOUR = 60 * 60_000

function scenario(o: { custody?: boolean; cleanupFails?: boolean } = {}) {
  const keys = keysFromPhrase(generatePhrase())
  const secret = hexlify(randomBytes(32))
  const account = Wallet.createRandom()
  let t = Date.parse('2026-11-10T10:00:00Z')
  const lastSessionAt = new Date(t - 5 * 60_000).toISOString()
  const claims: HatchClaim[] = []
  let sealed: Sealed | undefined
  let browserSealed: Sealed | undefined
  let file: HostingFile | undefined
  const sweeps: { at: number; vmId: string; key: string }[] = []
  const handover: HostingHandover = { v: 1, provider: 'fluence', hostingKey: account.privateKey, hostingAddress: account.address, vmId: 'vm-own', launchedAt: new Date(t - 60_000).toISOString(), lastSessionAt }
  const deps: HostingDeps = {
    launch: { launchId: 'L1', ...(o.custody === false ? {} : { hatch: { secret } }) },
    keys,
    board: {
      claimHatch: async (c) => { claims.push(c) },
      fetchHatchHandoff: async (a) => (a === keys.evm.address && sealed ? { handoff: sealed, ...(browserSealed ? { browserHandoff: browserSealed } : {}) } : undefined),
    },
    now: () => new Date(t),
    load: () => file,
    save: (f) => { file = JSON.parse(JSON.stringify(f)) },
    cleanup: async (f): Promise<FluenceCleanupReport> => {
      sweeps.push({ at: t, vmId: f.vmId, key: f.hostingKey })
      if (o.cleanupFails) throw new Error('Fluence down')
      return { at: new Date(t).toISOString(), apiKeysDeleted: ['k1'], vmsTerminated: ['stray'], draftsDiscarded: [], accountSshKeysDeleted: [], vmSshKeysCleared: true, errors: [] }
    },
  }
  return {
    keys, secret, account, claims, sweeps, deps, handover, lastSessionAt,
    file: () => file,
    seal: async (to = keys.evm.signingKey.publicKey, h: HostingHandover | HostingShardHandover = handover) => { sealed = await sealHostingHandover(to, h) },
    sealBrowser: async (s: BrowserShard, to = keys.evm.signingKey.publicKey) => { browserSealed = await sealBrowserShard(to, s) },
    advance: (ms: number) => { t += ms },
    now: () => t,
  }
}

describe('egg hosting hand-over', () => {
  it('2-of-2: waits for both sealed shards and assembles the account key only here', async () => {
    const s = scenario()
    const mem = {}
    const x1 = hexlify(randomBytes(32)), x2 = hexlify(randomBytes(32))
    const account = new Wallet(combineShards(x1, x2))
    const { hostingKey: _k, ...rest } = s.handover
    await s.seal(undefined, { ...rest, hostingAddress: account.address, v: 2, custody: 'mpc', shard: x1 })
    expect(await hostingStep(s.deps, mem)).toBe('waiting') // the backend's half alone
    expect(s.file()).toBeUndefined()
    await s.sealBrowser({ v: 2, custody: 'mpc', launchId: 'L1', hostingAddress: account.address, shard: x2 })
    expect(await hostingStep(s.deps, mem)).toBe('received')
    expect(s.file()).toMatchObject({ v: 1, hostingKey: account.privateKey, hostingAddress: account.address, vmId: 'vm-own' })
    expect(await hostingStep(s.deps, mem)).toBe('swept')
    expect(s.sweeps[0]!.key).toBe(account.privateKey)
  })

  it('claims with its hatch proof, waits, then stores its own hosting account', async () => {
    const s = scenario()
    const mem = {}
    expect(await hostingStep(s.deps, mem)).toBe('waiting')
    expect(s.claims).toEqual([{ launchId: 'L1', publicKey: s.keys.evm.signingKey.publicKey, proof: hatchProof(s.secret, s.keys.evm.signingKey.publicKey, s.keys.evm.address) }])
    expect(await hostingStep(s.deps, mem)).toBe('waiting')
    expect(s.claims).toHaveLength(1) // once per process
    await s.seal()
    expect(await hostingStep(s.deps, mem)).toBe('received')
    expect(s.file()).toMatchObject({ hostingKey: s.account.privateKey, hostingAddress: s.account.address, vmId: 'vm-own', cleanups: [] })
  })

  it('does nothing for eggs launched without hatch custody', async () => {
    const s = scenario({ custody: false })
    expect(await hostingStep(s.deps, {})).toBe('not-custody')
    expect(s.claims).toHaveLength(0)
  })

  it('refuses a hand-over sealed to someone else or naming the wrong account', async () => {
    const s = scenario()
    await s.seal(Wallet.createRandom().signingKey.publicKey)
    await expect(hostingStep(s.deps, {})).rejects.toThrow()
    await s.seal(undefined, { ...s.handover, hostingAddress: Wallet.createRandom().address })
    await expect(hostingStep(s.deps, {})).rejects.toThrow(/does not match/)
    expect(s.file()).toBeUndefined()
  })

  it('sweeps on receipt, again after the backend token expires, then daily', async () => {
    const s = scenario()
    await s.seal()
    await hostingStep(s.deps, {})
    expect(await hostingStep(s.deps, {})).toBe('swept')
    expect(s.sweeps).toEqual([{ at: s.now(), vmId: 'vm-own', key: s.account.privateKey }])
    const second = Date.parse(s.lastSessionAt) + 2 * HOUR + 15 * 60_000
    expect(Date.parse(s.file()!.nextCleanupAt)).toBe(second)
    expect(s.file()!.cleanups[0]).toMatchObject({ ok: true, summary: expect.stringContaining('1 API keys deleted, 1 VMs stopped') })

    s.advance(second - s.now() - 1)
    expect(await hostingStep(s.deps, {})).toBe('idle')
    s.advance(1)
    expect(await hostingStep(s.deps, {})).toBe('swept')
    expect(s.sweeps).toHaveLength(2)
    expect(Date.parse(s.file()!.nextCleanupAt)).toBe(s.now() + 24 * HOUR)
    s.advance(24 * HOUR)
    expect(await hostingStep(s.deps, {})).toBe('swept')
    expect(s.sweeps).toHaveLength(3)
  })

  it('retries a failed sweep soon', async () => {
    const s = scenario({ cleanupFails: true })
    await s.seal()
    await hostingStep(s.deps, {})
    expect(await hostingStep(s.deps, {})).toBe('swept')
    expect(s.file()!.cleanups[0]).toMatchObject({ ok: false, summary: 'sweep failed: Fluence down' })
    expect(Date.parse(s.file()!.nextCleanupAt)).toBe(s.now() + 15 * 60_000)
  })

  it('keeps hosting.json root-only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hosting-')), 'hosting.json')
    const store = hostingFileStore(path)
    expect(store.load()).toBeUndefined()
    store.save({ v: 1 } as HostingFile)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.load()).toEqual({ v: 1 })
  })
})
