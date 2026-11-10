import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { LOCKDOWN_SCRIPT, renderCloudInit } from '../src/cloud-init.js'

const launch = { maker: '0x' + 'ab'.repeat(20), configHash: '0x' + '11'.repeat(32), boardUrl: 'https://board.example', launchId: "it's-1" }
const image = 'ghcr.io/gremlins/egg@sha256:' + 'c'.repeat(64)

describe('cloud-init', () => {
  it('keeps launch data root-only when it carries a hatch secret', () => {
    const perms = (l: object) => parse(renderCloudInit({ launch: l as typeof launch, image })).write_files.find((f: { path: string }) => f.path === '/etc/gremlin/launch.json').permissions
    expect(perms(launch)).toBe('0644')
    expect(perms({ ...launch, hatch: { secret: '0x' + '22'.repeat(32) } })).toBe('0600')
  })
  it('pins the image by digest and refuses tags', () => {
    expect(renderCloudInit({ launch, image })).toContain(image)
    expect(() => renderCloudInit({ launch, image: 'ghcr.io/gremlins/egg:latest' })).toThrow()
  })
  it('locks the server down before starting the egg, and on every boot before networking', () => {
    const y = renderCloudInit({ launch, image })
    const c = parse(y)
    const files = Object.fromEntries(c.write_files.map((f: { path: string; content: string }) => [f.path, f.content]))
    expect(files['/usr/local/sbin/gremlin-lockdown']).toBe(LOCKDOWN_SCRIPT)
    expect(files['/etc/systemd/system/gremlin-lockdown.service']).toContain('Before=network-pre.target')
    expect(files['/etc/apt/apt.conf.d/99gremlin-lockdown']).toContain('DPkg::Post-Invoke')
    const run = c.runcmd.map((r: string[]) => r.join(' '))
    expect(run.indexOf('/usr/local/sbin/gremlin-lockdown')).toBeLessThan(run.findIndex((r: string) => r.startsWith('docker run')))
    expect(run).toContain('systemctl enable gremlin-lockdown.service')
    expect(y.indexOf('purge -y openssh-server')).toBeLessThan(y.indexOf('docker, run'))
  })
  it('the lockdown removes every key and console login, stops cloud-init rerunning, and never leaves a boot that needs the password', () => {
    expect(LOCKDOWN_SCRIPT).toContain('rm -f /root/.ssh/authorized_keys')
    expect(LOCKDOWN_SCRIPT).toContain('for d in /home/*/.ssh; do rm -f')
    expect(LOCKDOWN_SCRIPT).toContain('serial-getty@.service')
    expect(LOCKDOWN_SCRIPT).toContain('passwd -l root')
    expect(LOCKDOWN_SCRIPT).toContain('/etc/cloud/cloud-init.disabled')
    expect(LOCKDOWN_SCRIPT).toContain('--unrestricted')
    expect(LOCKDOWN_SCRIPT).toContain('rm -f /etc/grub.d/01_gremlin_lockdown') // the fail-safe
    expect(LOCKDOWN_SCRIPT).not.toContain('${')
  })
  it('has the host patch itself: daily unattended security upgrades, rebooting at night when needed', () => {
    const y = renderCloudInit({ launch, image })
    expect(y).toContain('packages: [docker.io, unattended-upgrades]')
    expect(y).toContain('APT::Periodic::Unattended-Upgrade "1";')
    expect(y).toContain('Unattended-Upgrade::Automatic-Reboot "true";')
  })
  it('keeps SSH for the team only on dev gremlins, from one root-owned key file, and records the keys so nests stay dev', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGremlinzDevKeyForTests0000000000000000000 gremlinz-dev'
    const y = renderCloudInit({ launch: { ...launch, dev: { sshKeys: [key] } }, image })
    const c = parse(y)
    const files = Object.fromEntries(c.write_files.map((f: { path: string; content: string }) => [f.path, f.content]))
    expect(c.users[0].name).toBe('gremlinz-dev')
    expect(files['/etc/ssh/gremlinz_dev_keys']).toBe(key + '\n')
    expect(files['/etc/ssh/sshd_config.d/00-gremlinz-dev.conf']).toContain('AuthorizedKeysFile /etc/ssh/gremlinz_dev_keys')
    expect(files['/etc/ssh/sshd_config.d/00-gremlinz-dev.conf']).toContain('AllowUsers gremlinz-dev')
    expect(y).not.toContain('purge -y openssh-server')
    expect(JSON.parse(files['/etc/gremlin/launch.json']).dev.sshKeys).toEqual([key])
    const plain = renderCloudInit({ launch, image })
    expect(plain).not.toContain('gremlinz-dev')
    expect(parse(plain).write_files.map((f: { path: string }) => f.path)).not.toContain('/etc/ssh/gremlinz_dev_keys') // no key file: the lockdown masks sshd
  })
  it('refuses a dev key that could break out of the YAML', () => {
    expect(() => renderCloudInit({ launch: { ...launch, dev: { sshKeys: ["ssh-ed25519 AAAA'\nruncmd: [rm]"] } }, image })).toThrow()
  })
  it('embeds launch data safely in single quotes', () => {
    expect(renderCloudInit({ launch, image })).toContain(`"launchId":"it''s-1"`)
  })
})
