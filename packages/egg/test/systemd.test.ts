import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WATCHDOG_SCRIPT } from '../src/systemd.js'

describe('host watchdog', () => {
  it('allows service recovery, restarts sustained failures, and respects a manual stop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-watchdog-')), log = join(dir, 'actions')
    const executable = (name: string, text: string) => { const file = join(dir, name); writeFileSync(file, '#!/bin/sh\n' + text, { mode: 0o700 }); return file }
    const script = executable('watchdog', WATCHDOG_SCRIPT.replace(/^#![^\n]*\n/, ''))
    const docker = executable('docker', 'echo unhealthy\n')
    executable('date', 'echo "$TEST_NOW"\n')
    executable('logger', 'exit 0\n')
    executable('systemctl', 'if [ "$1" = is-active ]; then echo "$TEST_ACTIVE"; else echo "$*" >> "$TEST_LOG"; fi\n')
    const run = (now: number, active = 'active') => {
      const result = spawnSync('/bin/sh', [script], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, GREMLIN_WATCHDOG_STATE: join(dir, 'state'), GREMLIN_DOCKER: docker, TEST_NOW: String(now), TEST_ACTIVE: active, TEST_LOG: log } })
      expect(result.status, result.stderr.toString()).toBe(0)
    }
    run(1000)
    run(1599)
    expect(spawnSync('/bin/sh', ['-n', script]).status).toBe(0)
    run(1601)
    expect(readFileSync(log, 'utf8')).toContain('--no-block restart gremlin.service')
    const before = readFileSync(log, 'utf8')
    run(3000, 'inactive')
    expect(readFileSync(log, 'utf8')).toBe(before)
  })
})
