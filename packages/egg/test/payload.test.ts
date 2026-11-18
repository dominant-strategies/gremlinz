import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPayload, decodePayload, encodePayload, restorePayload } from '../src/payload.js'

const dir = () => mkdtempSync(join(tmpdir(), 'payload-'))

describe('move-out payload', () => {
  it('round-trips egg files and the runtime directory, but never the old seed file or nest key', () => {
    const home = dir(), rt = dir()
    writeFileSync(join(home, 'state.json'), '{"stage":"hatched","pulseSeq":9}')
    writeFileSync(join(home, 'seed'), 'old seed file')
    writeFileSync(join(home, 'nest-key'), 'nope')
    mkdirSync(join(rt, 'skills/survival'), { recursive: true })
    writeFileSync(join(rt, 'skills/survival/SKILL.md'), '# survive')
    writeFileSync(join(rt, 'state.db'), Buffer.from([0, 1, 2, 255]))

    const p = decodePayload(encodePayload(collectPayload({ phrase: 'the phrase', gremlinHome: home, runtimeDir: rt, launch: { boardUrl: 'https://b' } })))
    expect(Object.keys(p.files).sort()).toEqual(['gremlin/launch.json', 'gremlin/state.json', 'runtime/skills/survival/SKILL.md', 'runtime/state.db'])

    const home2 = dir(), rt2 = dir()
    restorePayload(p, { gremlinHome: home2, runtimeDir: rt2 })
    expect(readFileSync(join(home2, 'seed'), 'utf8').trim()).toBe('the phrase')
    expect(JSON.parse(readFileSync(join(home2, 'state.json'), 'utf8')).pulseSeq).toBe(9)
    expect([...readFileSync(join(rt2, 'state.db'))]).toEqual([0, 1, 2, 255])
  })

  it('keeps API access, pending payments and spending history, leaving process locks behind', () => {
    const home = dir(), runtimeDir = dir()
    const files = ['hashference.json', 'inference-purchase.json', 'hosting-renewal.json', 'inference-ledger.jsonl', 'inference-credentials.json', 'inference-reservations.json', 'inference-sources.json', 'inference-docs.json', 'health-actions.jsonl', 'sends.jsonl']
    for (const file of [...files, 'inference-purchase.json.lock', 'runtime-health.json']) writeFileSync(join(home, file), file)
    const payload = collectPayload({ phrase: 'test phrase', gremlinHome: home, runtimeDir })
    const target = dir()
    restorePayload(payload, { gremlinHome: target, runtimeDir: dir() })
    for (const file of files) expect(readFileSync(join(target, file), 'utf8')).toBe(file)
    expect(Object.keys(payload.files)).toHaveLength(files.length)
  })

  it('moves newly acquired provider keys with owner-only permissions', () => {
    const home = dir(), target = dir()
    mkdirSync(join(home, 'inference-keys'))
    writeFileSync(join(home, 'inference-keys/provider.json'), '{"apiKey":"owned-key"}', { mode: 0o600 })
    writeFileSync(join(home, 'other-secret.json'), '{"apiKey":"not-an-inference-key"}')
    symlinkSync(join(home, 'other-secret.json'), join(home, 'inference-keys/link.json'))
    const payload = collectPayload({ phrase: 'test phrase', gremlinHome: home, runtimeDir: dir() })
    expect(payload.files['gremlin/inference-keys/link.json']).toBeUndefined()
    restorePayload(payload, { gremlinHome: target, runtimeDir: dir() })
    expect(readFileSync(join(target, 'inference-keys/provider.json'), 'utf8')).toBe('{"apiKey":"owned-key"}')
    expect(statSync(join(target, 'inference-keys/provider.json')).mode & 0o777).toBe(0o600)
  })

  it('refuses path traversal', () => {
    expect(() => restorePayload({ v: 1, phrase: 'x', files: { 'runtime/../../etc/passwd': '' } }, { gremlinHome: dir(), runtimeDir: dir() })).toThrow(/unsafe path/)
    expect(() => restorePayload({ v: 1, phrase: 'x', files: { 'elsewhere/a': '' } }, { gremlinHome: dir(), runtimeDir: dir() })).toThrow(/unknown area/)
  })

  it('keeps unexpired consumed approvals across a move and skips links in the agent workspace', () => {
    const home = dir(), runtimeDir = dir()
    const folder = join(home, 'maker-approvals')
    mkdirSync(folder)
    const live = '8f277334-e50e-4cc9-9ac0-ccf436e455bc'
    writeFileSync(join(folder, live), String(Date.now() + 60_000))
    writeFileSync(join(folder, '3f277334-e50e-4cc9-9ac0-ccf436e455bc'), '1')
    symlinkSync(join(folder, live), join(runtimeDir, 'shortcut'))
    const payload = collectPayload({ phrase: 'test phrase', gremlinHome: home, runtimeDir })
    expect(Object.keys(payload.files)).toEqual([`gremlin/maker-approvals/${live}`])
  })
})
