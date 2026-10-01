import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  it('refuses path traversal', () => {
    expect(() => restorePayload({ v: 1, phrase: 'x', files: { 'runtime/../../etc/passwd': '' } }, { gremlinHome: dir(), runtimeDir: dir() })).toThrow(/unsafe path/)
    expect(() => restorePayload({ v: 1, phrase: 'x', files: { 'elsewhere/a': '' } }, { gremlinHome: dir(), runtimeDir: dir() })).toThrow(/unknown area/)
  })
})
