import { describe, expect, it } from 'vitest'
// CLI modules export pure validation/collection helpers; imports do not execute SSH or read operator settings.
// @ts-ignore JS CLI has no separate declaration file.
import { collect, validateInventory } from '../../../scripts/dev-cluster-report.mjs'
// @ts-ignore JS CLI has no separate declaration file.
import { releaseChecks } from '../../../scripts/check-release.mjs'

describe('cluster operator scripts', () => {
  it('collects sanitized reports with fixed read-only remote commands and never disables host-key checks', () => {
    const calls: unknown[][] = []
    const reports = collect([{ name: 'alpha', sshTarget: 'gremlinz-dev@203.0.113.10' }], '2026-11-16T00:00:00Z', (...args: unknown[]) => { calls.push(args); if (JSON.stringify(args).includes('docker inspect')) return 'ghcr.io/gremlins/egg@sha256:' + 'a'.repeat(64); return JSON.stringify({ schema: 1, inference: {}, notes: [] }) })
    expect(reports[0].ok).toBe(true)
    const command = JSON.stringify(calls)
    expect(command).toContain('dist/dev/report.js')
    expect(command).not.toContain('StrictHostKeyChecking=no')
    expect(command).not.toContain('seed')
    expect(() => validateInventory([{ name: 'alpha', sshTarget: '-oProxyCommand=bad' }])).toThrow()
    expect(collect([{ name: 'alpha', sshTarget: 'user@host' }], undefined, () => { throw Error('private-remote-error') })[0].error).not.toContain('private-remote-error')
  })
  it('rejects mismatched release pins, moving runtime refs, ephemeral callbacks and uncommitted source', () => {
    const image = 'ghcr.io/gremlins/egg@sha256:' + 'a'.repeat(64)
    const env = { HERMES_RUNTIME_REF: 'b'.repeat(40), BOARD_EGG_IMAGE: image, VITE_EGG_IMAGE: image, BOARD_PUBLIC_URL: 'https://gremlinz.ai' }
    expect(releaseChecks(env, true).every((c: { ok: boolean }) => c.ok)).toBe(true)
    for (const changed of [{ HERMES_RUNTIME_REF: 'main' }, { VITE_EGG_IMAGE: image.replace('aaa', 'bbb') }, { BOARD_PUBLIC_URL: 'https://old.trycloudflare.com' }]) expect(releaseChecks({ ...env, ...changed }, true).some((c: { ok: boolean }) => !c.ok)).toBe(true)
    expect(releaseChecks(env, false).some((c: { ok: boolean }) => !c.ok)).toBe(true)
    const canary = { ...env, BOARD_CANARY_EGG_IMAGE: image, BOARD_CANARY_MAKERS: '0x' + 'a'.repeat(40) }
    expect(releaseChecks(canary, true).every((c: { ok: boolean }) => c.ok)).toBe(true)
    expect(releaseChecks({ ...canary, BOARD_CANARY_DEV_SSH_KEYS: 'invalid-public-key' }, true).some((c: { ok: boolean }) => !c.ok)).toBe(true)
  })
})
