import { describe, expect, it } from 'vitest'
import { renderCloudInit } from '../src/cloud-init.js'

const launch = { maker: '0x' + 'ab'.repeat(20), configHash: '0x' + '11'.repeat(32), boardUrl: 'https://board.example', launchId: "it's-1" }
const image = 'ghcr.io/gremlins/egg@sha256:' + 'c'.repeat(64)

describe('cloud-init', () => {
  it('pins the image by digest and refuses tags', () => {
    expect(renderCloudInit({ launch, image })).toContain(image)
    expect(() => renderCloudInit({ launch, image: 'ghcr.io/gremlins/egg:latest' })).toThrow()
  })
  it('locks the server down before starting the egg', () => {
    const y = renderCloudInit({ launch, image })
    expect(y.indexOf('purge -y openssh-server')).toBeLessThan(y.indexOf('docker, run'))
    expect(y).toContain('passwd, -l, root')
    expect(y).toContain('authorized_keys')
  })
  it('has the host patch itself: daily unattended security upgrades, rebooting at night when needed', () => {
    const y = renderCloudInit({ launch, image })
    expect(y).toContain('packages: [docker.io, unattended-upgrades]')
    expect(y).toContain('APT::Periodic::Unattended-Upgrade "1";')
    expect(y).toContain('Unattended-Upgrade::Automatic-Reboot "true";')
  })
  it('keeps SSH for the team only on dev gremlins, and records the keys so nests stay dev', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGremlinzDevKeyForTests0000000000000000000 gremlinz-dev'
    const y = renderCloudInit({ launch: { ...launch, dev: { sshKeys: [key] } }, image })
    expect(y).toContain('name: gremlinz-dev')
    expect(y).toContain(`- '${key}'`)
    expect(y).not.toContain('purge -y openssh-server')
    expect(y).toContain('/home/gremlinz-dev/.ssh') // other users' keys still go
    expect(y).toContain('"dev":{"sshKeys":')
    expect(y.indexOf('passwd, -l, root')).toBeLessThan(y.indexOf('docker, run'))
    expect(renderCloudInit({ launch, image })).not.toContain('gremlinz-dev')
  })
  it('refuses a dev key that could break out of the YAML', () => {
    expect(() => renderCloudInit({ launch: { ...launch, dev: { sshKeys: ["ssh-ed25519 AAAA'\nruncmd: [rm]"] } }, image })).toThrow()
  })
  it('embeds launch data safely in single quotes', () => {
    expect(renderCloudInit({ launch, image })).toContain(`"launchId":"it''s-1"`)
  })
})
