import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SigningKey, Wallet, hexlify, randomBytes } from 'ethers'
import { configHash, hatchProof, openHostingHandover, signMessage } from '@gremlins/hatch'
import { TopUpUnderReview, type TopUpAuthorization } from '@gremlins/hosting'
import { HatchStore } from '../src/hatch-store.ts'
import { hatchWorker, type FluenceClient, type HatchConfig, type HatchDeps } from '../src/hatch.ts'
import { announcement, makeBoard, makeConfig, type Board } from './helpers.ts'

const SECRET = 'test-hatch-secret-0123456789abcdef-0123456789'
const cfg: HatchConfig = { image: 'ghcr.io/gremlins/egg@sha256:' + 'c'.repeat(64), devSshKeys: [], publicUrl: 'https://board.example', topUpUsd: 10 }
const MICRO = 1_000_000n

type TopUpMode = 'ok' | 'review' | 'lost' // lost: signed and sent, then the response never came back

/** Fake Fluence + Base: one shared world, so a "restarted" worker sees what the old one did. */
function world(clock: { now: number }) {
  const w = {
    usdc: new Map<string, bigint>(),
    quai: new Map<string, bigint>(),
    usedNonces: new Set<string>(),
    deposited: new Map<string, number>(),
    topUps: [] as { address: string; auth: TopUpAuthorization }[],
    logins: [] as { address: string; at: number }[],
    drafts: [] as { address: string; cloudInit: string; idempotencyKey: string }[],
    vms: new Map<string, { status: string }>(),
    swaps: [] as { address: string; amount: bigint }[],
    topUpMode: 'ok' as TopUpMode,
    /** Whether a "lost" payment actually settled on-chain. */
    lostSettles: false,
  }
  const fluenceFor = (key: string): FluenceClient => {
    const address = new Wallet(key).address
    let token = false
    const authed = () => { if (!token) throw new Error('call login() first') }
    return {
      async topUp(amountUsd, o) {
        const auth: TopUpAuthorization = { primaryType: 'TransferWithAuthorization', nonce: hexlify(randomBytes(32)), validBefore: Math.floor(clock.now / 1000) + 300, value: String(BigInt(amountUsd) * MICRO) }
        await o.onAuthorization?.(auth)
        w.topUps.push({ address, auth })
        const pay = () => {
          w.usedNonces.add(auth.nonce)
          w.usdc.set(address, (w.usdc.get(address) ?? 0n) - BigInt(amountUsd) * MICRO)
          w.deposited.set(address, (w.deposited.get(address) ?? 0) + amountUsd)
        }
        if (w.topUpMode === 'review') throw new TopUpUnderReview()
        if (w.topUpMode === 'lost') {
          if (w.lostSettles) pay()
          throw new Error('socket hang up')
        }
        pay()
        return { transaction: '0xpaid' }
      },
      async login() {
        if (!w.deposited.get(address)) throw new Error('Fluence sign-in failed (401): no account')
        token = true
        w.logins.push({ address, at: clock.now })
      },
      async totalDeposited() { authed(); return w.deposited.get(address) ?? 0 },
      async cheapestPlan() { authed(); return { clusterId: 'c', configurationId: 'small', vcpu: 1, ramGb: 2, hourlyUsd: 0.004 } },
      async ubuntuImageId() { authed(); return 'u24' },
      async createDraft(o) {
        authed()
        const existing = w.drafts.findIndex((d) => d.idempotencyKey === o.idempotencyKey && d.address === address)
        if (existing >= 0) return { id: `vm-${existing}` }
        w.drafts.push({ address, cloudInit: o.cloudInit, idempotencyKey: o.idempotencyKey })
        const id = `vm-${w.drafts.length - 1}`
        w.vms.set(id, { status: 'draft' })
        return { id }
      },
      async provision(id) { authed(); w.vms.get(id)!.status = 'launching'; return {} },
      async vm(id) { authed(); return { id, status: w.vms.get(id)!.status } },
    }
  }
  const deps = (b: Board): HatchDeps => ({
    now: () => clock.now,
    fluence: fluenceFor,
    base: {
      usdc: async (a) => w.usdc.get(a) ?? 0n,
      quai: async (a) => w.quai.get(a) ?? 0n,
      authorizationUsed: async (_a, nonce) => w.usedNonces.has(nonce),
      async sellQuai(key, amount) {
        const a = new Wallet(key).address
        w.swaps.push({ address: a, amount })
        w.quai.set(a, 0n)
        w.usdc.set(a, (w.usdc.get(a) ?? 0n) + (amount / 10n ** 18n) * MICRO / 10n) // 10 QUAI per USDC
        return { uid: '0xorder', status: 'fulfilled' }
      },
    },
    findEgg: (launchId) => b.store.getEggByLaunchId(launchId),
  })
  return { w, deps }
}

async function setup(path = ':memory:') {
  const hatchStore = new HatchStore(path, SECRET)
  const b = await makeBoard({}, { hatch: { store: hatchStore, cfg } })
  const { w, deps } = world(b.clock)
  const d = deps(b)
  const worker = hatchWorker({ store: hatchStore, cfg, deps: d, log: () => {} })
  const maker = Wallet.createRandom()
  const config = makeConfig(maker.address)
  const launchId = 'launch-' + hexlify(randomBytes(6)).slice(2)
  const body = { maker: maker.address, configHash: configHash(config), launchId, boardUrl: cfg.publicUrl }
  return { b, w, d, hatchStore, worker, maker, config, launchId, body, path }
}

/** Run worker passes until the job reaches `status` (or give up). */
async function until(s: Awaited<ReturnType<typeof setup>>, jobId: string, status: string, worker = s.worker, store = s.hatchStore, max = 12) {
  for (let i = 0; i < max; i++) {
    if (store.get(jobId)!.status === status) return store.get(jobId)!
    s.b.clock.now += 61_000
    await worker.tick()
  }
  return store.get(jobId)!
}

/** The egg the backend launched: announces itself, then claims with its hatch secret (read from the cloud-init). */
async function eggBoots(s: Awaited<ReturnType<typeof setup>>, jobId: string, egg = Wallet.createRandom()) {
  const secret = /"hatch":\{"secret":"(0x[0-9a-f]{64})"\}/.exec(s.w.drafts.at(-1)!.cloudInit)![1]
  expect(secret).toBe(s.hatchStore.get(jobId)!.secret)
  const ann = await s.b.postJson('/api/eggs', await signMessage(egg, announcement(egg, s.maker.address, s.body.configHash, s.launchId)))
  expect(ann.status).toBe(201)
  const claim = { launchId: s.launchId, publicKey: egg.signingKey.publicKey, proof: hatchProof(secret, egg.signingKey.publicKey, egg.address) }
  expect((await s.b.postJson('/api/hatch/claim', claim)).status).toBe(201)
  return egg
}

describe('hatch custody: jobs', () => {
  it('creates a job with a fresh hosting key, renders the cloud-init itself, and never returns a secret', async () => {
    const s = await setup()
    const r = await s.b.postJson('/api/hatch/fluence', s.body)
    expect(r.status).toBe(201)
    expect(r.body).toEqual({ jobId: expect.any(String), hostingAddress: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/), minUsd: 10 })
    const job = s.hatchStore.get(r.body.jobId)!
    expect(new Wallet(job.key!).address).toBe(r.body.hostingAddress)
    // at rest: encrypted, not in the JSON data
    const raw = s.hatchStore.raw(job.id)!
    for (const v of Object.values(raw)) expect(String(v)).not.toContain(job.key!.slice(2))
    for (const v of Object.values(raw)) expect(String(v)).not.toContain(job.secret!.slice(2))
    const view = await s.b.json(`/api/hatch/${job.id}`)
    expect(view.body.job).toMatchObject({ status: 'funding', hostingAddress: r.body.hostingAddress, minUsd: 10, keyDeleted: false })
    expect(JSON.stringify(view.body)).not.toContain(job.key!.slice(2))
    expect(JSON.stringify(view.body)).not.toContain(job.secret!.slice(2))
    // same request again: same job; another maker under the launchId: refused
    expect((await s.b.postJson('/api/hatch/fluence', s.body)).body.jobId).toBe(job.id)
    expect((await s.b.postJson('/api/hatch/fluence', { ...s.body, maker: Wallet.createRandom().address })).status).toBe(409)
  })

  it('refuses launch data a maker could use to steer the egg', async () => {
    const s = await setup()
    expect((await s.b.postJson('/api/hatch/fluence', { ...s.body, boardUrl: 'https://evil.example' })).status).toBe(400)
    // only the four public fields: no image, dev keys or hatch secret from the browser
    for (const extra of [{ image: 'evil@sha256:' + 'a'.repeat(64) }, { dev: { sshKeys: ['ssh-ed25519 AAAA evil'] } }, { hatch: { secret: '0x' + '1'.repeat(64) } }])
      expect((await s.b.postJson('/api/hatch/fluence', { ...s.body, ...extra })).status).toBe(400)
    expect((await s.b.postJson('/api/hatch/fluence', { ...s.body, maker: 'nope' })).status).toBe(400)
  })

  it('rate-limits new jobs per client IP', async () => {
    const s = await setup()
    const post = (i: number, ip: string) => s.b.json('/api/hatch/fluence', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ ...s.body, launchId: `L-${ip}-${i}` }) })
    for (let i = 0; i < 10; i++) expect((await post(i, '203.0.113.7')).status).toBe(201)
    expect((await post(10, '203.0.113.7')).status).toBe(429)
    expect((await post(0, '198.51.100.1')).status).toBe(201)
  })

  it('answers 503 when hatching is not configured', async () => {
    const b = await makeBoard()
    expect((await b.postJson('/api/hatch/fluence', {})).status).toBe(503)
  })
})

describe('hatch custody: state machine', () => {
  it('funding → topped-up → launched → handed-off → key deleted, and only the egg can open the hand-over', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    await s.worker.tick()
    expect(s.hatchStore.get(jobId)!.status).toBe('funding')
    expect(s.w.topUps).toHaveLength(0)

    s.w.usdc.set(hostingAddress, 12n * MICRO) // maker sends USDC on Base
    expect((await until(s, jobId, 'topped-up')).topUp).toMatchObject({ transaction: '0xpaid', paidAt: expect.any(Number) })
    expect(s.w.topUps).toHaveLength(1)
    const launching = await until(s, jobId, 'launching')
    expect(s.w.drafts).toHaveLength(1)
    expect(s.w.drafts[0]!.idempotencyKey).toBe(`egg-${s.launchId}`)
    expect(s.w.drafts[0]!.cloudInit).toContain(cfg.image)
    expect(s.w.drafts[0]!.cloudInit).toContain(`"boardUrl":"${cfg.publicUrl}"`)
    s.w.vms.get(launching.vmId!)!.status = 'launching'
    await s.worker.tick()
    s.w.vms.get(launching.vmId!)!.status = 'launched'
    const launched = await until(s, jobId, 'launched')
    expect(launched.launchedAt).toBeTypeOf('number')

    // nothing is handed over until the egg claims
    for (let i = 0; i < 3; i++) await s.worker.tick()
    expect(s.hatchStore.get(jobId)!.status).toBe('launched')
    const handoffBefore = await s.b.json(`/api/hatch/handoff/${Wallet.createRandom().address}`)
    expect(handoffBefore.status).toBe(404)

    const egg = await eggBoots(s, jobId)
    const done = await until(s, jobId, 'done')
    expect(done.key).toBeNull()
    expect(done.secret).toBeNull()
    expect(done.keyDeletedAt).toBeTypeOf('number')
    const raw = s.hatchStore.raw(jobId)!
    expect(raw.key_enc).toBeNull()
    expect(raw.secret_enc).toBeNull()
    expect(done.log.map((l) => l.event)).toEqual(expect.arrayContaining(['funded', 'topped up', 'hosting account sealed to the egg', 'our copy of the key deleted']))

    const h = await s.b.json(`/api/hatch/handoff/${egg.address}`)
    expect(h.status).toBe(200)
    expect(h.body.vmId).toBe(launching.vmId)
    const opened = await openHostingHandover(egg.signingKey, h.body.handoff)
    expect(opened).toMatchObject({ provider: 'fluence', hostingAddress, vmId: launching.vmId })
    expect(new Wallet(opened.hostingKey).address).toBe(hostingAddress)
    expect(Date.parse(opened.lastSessionAt)).toBe(Math.max(...s.w.logins.map((l) => l.at)))
    await expect(openHostingHandover(new SigningKey(hexlify(randomBytes(32))), h.body.handoff)).rejects.toThrow()

    // after the hand-over the backend never signs in again (the egg's sweep times itself from lastSessionAt)
    const logins = s.w.logins.length
    for (let i = 0; i < 3; i++) await s.worker.tick()
    expect(s.w.logins).toHaveLength(logins)
    const view = (await s.b.json(`/api/hatch/${jobId}`)).body.job
    expect(view).toMatchObject({ status: 'done', keyDeleted: true, eggAddress: egg.address, vmId: launching.vmId })
  })

  it('swaps QUAI bridged to the hosting address with the hosting key, then pays', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.quai.set(hostingAddress, 120n * 10n ** 18n)
    await until(s, jobId, 'topped-up')
    expect(s.w.swaps).toEqual([{ address: hostingAddress, amount: 120n * 10n ** 18n }])
    expect(s.hatchStore.get(jobId)!.swaps).toEqual([expect.objectContaining({ uid: '0xorder', status: 'fulfilled' })])
    expect(s.w.topUps).toHaveLength(1)
  })

  it('hands over only to the egg that proves the hatch secret', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.usdc.set(hostingAddress, 10n * MICRO)
    const launching = await until(s, jobId, 'launching')
    s.w.vms.get(launching.vmId!)!.status = 'launched'
    await until(s, jobId, 'launched')

    // the maker (who knows launchId) announces a look-alike egg first and claims without the secret
    const fake = Wallet.createRandom()
    expect((await s.b.postJson('/api/eggs', await signMessage(fake, announcement(fake, s.maker.address, s.body.configHash, s.launchId)))).status).toBe(201)
    const guess = { launchId: s.launchId, publicKey: fake.signingKey.publicKey, proof: hatchProof(hexlify(randomBytes(32)), fake.signingKey.publicKey, fake.address) }
    expect((await s.b.postJson('/api/hatch/claim', guess)).status).toBe(403)
    // a real egg's proof replayed under another key is useless too
    const real = Wallet.createRandom()
    const secret = s.hatchStore.get(jobId)!.secret!
    const stolen = { ...guess, proof: hatchProof(secret, real.signingKey.publicKey, real.address) }
    expect((await s.b.postJson('/api/hatch/claim', stolen)).status).toBe(403)
    for (let i = 0; i < 3; i++) await s.worker.tick()
    expect(s.hatchStore.get(jobId)!.status).toBe('launched')
    expect((await s.b.json(`/api/hatch/handoff/${fake.address}`)).status).toBe(404)

    // the real egg's claim is good, but its announcement lost the launchId race: still no hand-over to anyone
    const claim = { launchId: s.launchId, publicKey: real.signingKey.publicKey, proof: hatchProof(secret, real.signingKey.publicKey, real.address) }
    expect((await s.b.postJson('/api/hatch/claim', claim)).status).toBe(201)
    expect((await s.b.postJson('/api/hatch/claim', claim)).status).toBe(200)
    for (let i = 0; i < 3; i++) await s.worker.tick()
    expect(s.hatchStore.get(jobId)!.handoff).toBeUndefined()
  })
})

describe('hatch custody: crash safety', () => {
  it('resumes every job after a restart, with keys still encrypted in a 0600 file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hatch-'))
    const path = join(dir, 'hatch.db')
    const s = await setup(path)
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    expect(statSync(path).mode & 0o777).toBe(0o600)
    s.w.usdc.set(hostingAddress, 10n * MICRO)
    const launching = await until(s, jobId, 'launching')
    s.hatchStore.close()

    // new process: new store on the same file, new worker and deps (no Fluence session carried over)
    const store2 = new HatchStore(path, SECRET)
    expect(store2.get(jobId)!.key).toBe(launching.key)
    expect(() => new HatchStore(path, 'another-secret-another-secret-another').get(jobId)).toThrow()
    const deps2 = { ...s.d }
    const worker2 = hatchWorker({ store: store2, cfg, deps: deps2, log: () => {} })
    s.w.vms.get(launching.vmId!)!.status = 'launched'
    await until(s, jobId, 'launched', worker2, store2)
    // resumed: no second payment, no second server
    expect(s.w.topUps).toHaveLength(1)
    expect(s.w.drafts).toHaveLength(1)
    store2.close()
  })

  it('a draft created just before a crash comes back, not a second server', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.usdc.set(hostingAddress, 10n * MICRO)
    const toppedUp = await until(s, jobId, 'topped-up')
    // crash after Fluence made the draft but before we saved its id
    const fl = s.d.fluence(toppedUp.key!)
    await fl.login()
    await fl.createDraft({ name: 'x', plan: await fl.cheapestPlan(), imageId: 'u24', cloudInit: '', idempotencyKey: `egg-${s.launchId}` })
    await until(s, jobId, 'launching')
    expect(s.w.drafts).toHaveLength(1)
  })

  it('a payment whose response was lost but settled is not paid again', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.usdc.set(hostingAddress, 20n * MICRO)
    s.w.topUpMode = 'lost'
    s.w.lostSettles = true
    await until(s, jobId, 'paying')
    await s.worker.tick() // pays; the response is lost
    expect(s.w.topUps).toHaveLength(1)
    expect(s.hatchStore.get(jobId)!.topUp!.auths).toHaveLength(1) // recorded before signing
    s.w.topUpMode = 'ok'
    expect((await until(s, jobId, 'topped-up')).status).toBe('topped-up')
    expect(s.w.topUps).toHaveLength(1)
    expect(s.w.usdc.get(hostingAddress)).toBe(10n * MICRO)
  })

  it('a lost payment that never settled waits out its authorization before paying again', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.usdc.set(hostingAddress, 10n * MICRO)
    s.w.topUpMode = 'lost'
    await until(s, jobId, 'paying')
    await s.worker.tick()
    expect(s.w.topUps).toHaveLength(1)
    const validBefore = s.hatchStore.get(jobId)!.topUp!.auths[0]!.validBefore * 1000
    s.w.topUpMode = 'ok'
    // still inside the authorization window: it could still settle, so nothing new is signed
    while (s.b.clock.now < validBefore) {
      await s.worker.tick()
      s.b.clock.now += 30_000
      expect(s.w.topUps).toHaveLength(1)
    }
    s.b.clock.now = validBefore + 3 * 60_000
    await until(s, jobId, 'topped-up')
    expect(s.w.topUps).toHaveLength(2)
    expect(s.w.usedNonces.size).toBe(1)
  })

  it('a top-up under review is never paid again, and goes on once Fluence credits it', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.usdc.set(hostingAddress, 30n * MICRO)
    s.w.topUpMode = 'review'
    await until(s, jobId, 'paying')
    await s.worker.tick()
    expect(s.hatchStore.get(jobId)!.topUp!.underReview).toBe(true)
    s.w.topUpMode = 'ok'
    for (let i = 0; i < 10; i++) {
      s.b.clock.now += 60 * 60_000
      await s.worker.tick()
    }
    expect(s.w.topUps).toHaveLength(1)
    expect(s.hatchStore.get(jobId)!.status).toBe('paying')
    expect((await s.b.json(`/api/hatch/${jobId}`)).body.job.topUp.underReview).toBe(true)
    s.w.deposited.set(hostingAddress, 10) // review cleared, account credited
    await until(s, jobId, 'topped-up')
    expect(s.w.topUps).toHaveLength(1)
  })

  it('a crash after the authorization was recorded resolves from the chain, not by paying', async () => {
    const s = await setup()
    const { jobId, hostingAddress } = (await s.b.postJson('/api/hatch/fluence', s.body)).body
    s.w.usdc.set(hostingAddress, 10n * MICRO)
    await until(s, jobId, 'paying')
    // what a process killed mid-request leaves behind: an attempt with its authorization, no outcome
    const job = s.hatchStore.get(jobId)!
    const nonce = hexlify(randomBytes(32))
    job.topUp = { startedAt: s.b.clock.now, auths: [{ primaryType: 'TransferWithAuthorization', nonce, validBefore: Math.floor(s.b.clock.now / 1000) + 300 }] }
    s.hatchStore.save(job)
    s.w.usedNonces.add(nonce) // the facilitator settled it
    s.w.deposited.set(hostingAddress, 10)
    await until(s, jobId, 'topped-up')
    expect(s.w.topUps).toHaveLength(0)
  })
})
