import { afterEach, describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { HatchStore } from '../src/hatch-store.ts'
import { eggCloudInit, newJob, type HatchConfig } from '../src/hatch.ts'
import { hatchFromEnv } from '../src/hatch-live.ts'
import { makeBoard, type Board } from './helpers.ts'

const stable = 'ghcr.io/gremlins/egg@sha256:' + 'a'.repeat(64)
const candidate = 'ghcr.io/gremlins/egg@sha256:' + 'b'.repeat(64)
const key = 'ssh-ed25519 AAAATEST operator'
const cleanup: (() => unknown)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function setup() {
  const maker = Wallet.createRandom(), other = Wallet.createRandom()
  const store = new HatchStore(':memory:', 'test-hatch-secret-0123456789abcdef-0123456789')
  const cfg: HatchConfig = { image: stable, publicUrl: 'https://board.example', devSshKeys: [], topUpUsd: 10, canary: { image: candidate, devSshKeys: [key], makers: [maker.address] } }
  const b = await makeBoard({}, { hatch: { cfg, store } })
  cleanup.push(() => store.close(), () => b.store.close())
  const body = { maker: maker.address, configHash: '0x' + 'c'.repeat(64), launchId: 'test-canary', boardUrl: cfg.publicUrl }
  return { maker, other, store, cfg, b, body }
}

describe('signed website canaries', () => {
  it('keeps ordinary website launches on the stable image and dev access unchanged', async () => {
    const { b, store, body } = await setup()
    const result = await b.postJson('/api/hatch/fluence', body)
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ channel: 'stable', image: stable })
    expect(store.get(result.body.jobId)?.release?.devSshKeys).toEqual([])
    expect((await b.json('/api/hatch/config')).body.fluence.canary).toBe(true)
  })
  it('requires a real signature from an allowlisted maker; a forged maker field cannot select the candidate', async () => {
    const { b, maker, other, store, body } = await setup()
    expect((await b.postJson('/api/hatch/fluence/canary', body)).status).toBe(401)
    expect((await b.signedPost(other, '/api/hatch/fluence/canary', body)).status).toBe(403)
    expect((await b.signedPost(other, '/api/hatch/fluence/canary', { ...body, maker: other.address })).status).toBe(403)
    const result = await b.signedPost(maker, '/api/hatch/fluence/canary', body)
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ channel: 'canary', image: candidate })
    expect(store.get(result.body.jobId)?.release?.devSshKeys).toEqual([key])
    expect((await b.signedPost(maker, '/api/hatch/fluence/canary', body)).status).toBe(401) // replay
  })
  it('persists the release per job so a board upgrade cannot switch an already funded deployment', async () => {
    const { b, maker, store, body, cfg } = await setup()
    const result = await b.signedPost(maker, '/api/hatch/fluence/canary', body)
    const job = store.get(result.body.jobId)!
    cfg.image = 'ghcr.io/gremlins/egg@sha256:' + 'd'.repeat(64)
    cfg.canary!.image = 'ghcr.io/gremlins/egg@sha256:' + 'e'.repeat(64)
    const rendered = eggCloudInit(cfg, job, job.secret!)
    expect(rendered).toContain(candidate)
    expect(rendered).toContain(key)
    expect(rendered).not.toContain(cfg.canary!.image)
    expect((await b.postJson('/api/hatch/fluence', body)).status).toBe(409)
    b.clock.now += 1000
    expect((await b.signedPost(maker, '/api/hatch/fluence/canary', body)).body.image).toBe(candidate)
    delete cfg.canary
    b.clock.now += 1000
    expect((await b.signedPost(maker, '/api/hatch/fluence/canary', body)).body.image).toBe(candidate)
    expect((await b.signedPost(maker, '/api/hatch/fluence/canary', { ...body, launchId: 'new-disabled-job' })).status).toBe(503)
  })
  it('cannot inject an image or dev keys into the public launch request', async () => {
    const { b, body } = await setup()
    expect((await b.postJson('/api/hatch/fluence', { ...body, image: candidate })).status).toBe(400)
    expect((await b.postJson('/api/hatch/fluence', { ...body, dev: { sshKeys: [key] } })).status).toBe(400)
  })
  it('fails incomplete operator canary configuration before a launch can be funded', () => {
    const env = { BOARD_HATCH_SECRET: 'test-hatch-secret-0123456789abcdef-0123456789', BOARD_EGG_IMAGE: stable, BOARD_PUBLIC_URL: 'https://board.example', BOARD_CANARY_EGG_IMAGE: candidate }
    expect(() => hatchFromEnv(env, ':memory:')).toThrow(/MAKERS/)
    const maker = Wallet.createRandom()
    expect(() => hatchFromEnv({ ...env, BOARD_CANARY_MAKERS: maker.address }, ':memory:')).toThrow(/SSH/)
    expect(() => hatchFromEnv({ ...env, BOARD_CANARY_MAKERS: maker.address, BOARD_CANARY_DEV_SSH_KEYS: 'not-a-public-key' }, ':memory:')).toThrow(/SSH/)
    const h = hatchFromEnv({ ...env, BOARD_CANARY_MAKERS: maker.address, BOARD_CANARY_DEV_SSH_KEYS: key }, ':memory:')!
    cleanup.push(() => h.store.close())
    expect(h.cfg.image).toBe(stable)
    expect(h.cfg.canary?.image).toBe(candidate)
  })
})
