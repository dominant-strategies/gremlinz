#!/usr/bin/env node
// Read-only collection after website launches. Inventory holds public identity/SSH targets, never private keys.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateInventory(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error('inventory must contain 1–20 entries')
  const names = new Set()
  return value.map(entry => {
    if (!entry || !/^[a-zA-Z0-9_-]{1,60}$/.test(entry.name) || names.has(entry.name)) throw new Error('inventory needs unique simple names')
    if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(entry.sshTarget) || entry.sshTarget.startsWith('-')) throw new Error('sshTarget must be user@host without options')
    if (entry.expectedImage && !/^[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(entry.expectedImage)) throw new Error('expectedImage must be pinned by digest')
    if (entry.address && !/^0x[0-9a-fA-F]{40}$/.test(entry.address)) throw new Error('address must be a public EVM address')
    names.add(entry.name)
    return { name: entry.name, sshTarget: entry.sshTarget, ...(entry.address ? { address: entry.address } : {}), ...(entry.expectedImage ? { expectedImage: entry.expectedImage } : {}) }
  })
}
export function collect(inventory, since, run = execFileSync) {
  const timestamp = since === undefined ? undefined : new Date(since).toISOString()
  return validateInventory(inventory).map(entry => {
    try {
      const command = 'sudo -n docker exec egg node /app/packages/gremlin-mcp/dist/dev/report.js' + (timestamp ? ` --since '${timestamp}'` : '')
      const raw = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', entry.sshTarget, command], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      const report = JSON.parse(raw)
      if (report.schema !== 1 || !report.inference || !Array.isArray(report.notes)) throw new Error('unsupported report')
      const image = String(run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', entry.sshTarget, "sudo -n docker inspect --format '{{.Config.Image}}' egg"], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] })).trim()
      if (!/^[a-z0-9][a-z0-9._/@:\-]{1,255}$/.test(image)) throw new Error('invalid running image reference')
      return { ...entry, ok: !entry.expectedImage || entry.expectedImage === image, image, imagePinned: /@sha256:[a-f0-9]{64}$/.test(image), report }
    } catch { return { ...entry, ok: false, error: 'Could not collect report; check dev SSH authorization, host key, image version and container status.' } }
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
  if (process.argv.includes('--help')) console.log('Usage: node scripts/dev-cluster-report.mjs --inventory .tmp/cluster.json [--since ISO] [--out .tmp/cluster-report.json]')
  else {
    try {
      const file = arg('--inventory')
      if (!file) throw new Error('--inventory is required; create it after launching through the website')
      const agents = collect(JSON.parse(readFileSync(file, 'utf8')), arg('--since'))
      const report = JSON.stringify({ collectedAt: new Date().toISOString(), agents }, null, 2) + '\n'
      const output = arg('--out')
      if (output) { mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output, report, { mode: 0o600 }); chmodSync(output, 0o600); console.log(`Report saved to ${output}`) }
      else process.stdout.write(report)
      if (agents.some(a => !a.ok)) process.exitCode = 1
    } catch (e) { console.error(e.message); process.exitCode = 1 }
  }
}
