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
  it('embeds launch data safely in single quotes', () => {
    expect(renderCloudInit({ launch, image })).toContain(`"launchId":"it''s-1"`)
  })
})
