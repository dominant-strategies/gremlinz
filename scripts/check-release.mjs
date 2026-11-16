#!/usr/bin/env node
// Local, read-only release preflight. It prints status only, never values from secret settings.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
export function releaseChecks(env, clean) {
  const digest = /^[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/
  const board = env.BOARD_EGG_IMAGE, site = env.VITE_EGG_IMAGE
  const checks = [
    { name: 'clean working tree', ok: clean },
    { name: 'Hermes runtime pinned to a commit', ok: /^[a-f0-9]{40}$/.test(env.HERMES_RUNTIME_REF ?? '') },
    { name: 'backend egg image pinned by digest', ok: digest.test(board ?? '') },
    { name: 'frontend/backend image match', ok: !!board && site === board },
    { name: 'permanent HTTPS board origin', ok: (() => { try { const u = new URL(env.BOARD_PUBLIC_URL); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && !/(?:^|\.)(?:localhost|trycloudflare\.com)$/.test(u.hostname) && !/^(127\.|0\.)/.test(u.hostname) } catch { return false } })() },
    { name: 'matching optional bundle metadata', ok: (() => {
      const b = env.BOARD_EGG_ARTIFACT_URL, v = env.VITE_EGG_ARTIFACT_URL, bs = env.BOARD_EGG_ARTIFACT_SHA256, vs = env.VITE_EGG_ARTIFACT_SHA256
      if (!b && !v && !bs && !vs) return true
      try { return b === v && bs === vs && /^[a-f0-9]{64}$/.test(bs ?? '') && new URL(b).protocol === 'https:' } catch { return false }
    })() },
  ]
  if (env.BOARD_CANARY_EGG_IMAGE) {
    const makers = String(env.BOARD_CANARY_MAKERS ?? '').split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
    checks.push({ name: 'candidate image pinned by digest', ok: digest.test(env.BOARD_CANARY_EGG_IMAGE) })
    checks.push({ name: 'candidate restricted to approved maker wallets', ok: makers.length > 0 && makers.every(a => /^0x[0-9a-fA-F]{40}$/.test(a)) })
    const devKeys = String(env.BOARD_CANARY_DEV_SSH_KEYS || env.BOARD_EGG_DEV_SSH_KEYS || 'team').trim()
    checks.push({ name: 'candidate dev SSH monitoring configured', ok: devKeys === 'team' || devKeys.split(/[,\n]+/).every(k => /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [^\n']*)?$/.test(k.trim())) })
    const url = env.BOARD_CANARY_ARTIFACT_URL, sum = env.BOARD_CANARY_ARTIFACT_SHA256
    checks.push({ name: 'candidate bundle metadata paired', ok: (!url && !sum) || (!!url && /^[a-f0-9]{64}$/.test(sum ?? '') && (() => { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password } catch { return false } })()) })
  }
  return checks
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const clean = !execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  const checks = releaseChecks(process.env, clean)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`)
  if (checks.some(c => !c.ok)) process.exitCode = 1
}
