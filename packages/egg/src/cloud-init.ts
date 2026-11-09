/**
 * cloud-init user data for an egg server. Browser-safe (pure string building) so the launch page can use it.
 *
 * The server is locked down before the egg starts: SSH is removed, root's password is locked and any
 * provider-injected authorized_keys are deleted. Dev gremlins (launch data `dev`) keep SSH for the team's keys only. With nobody left to log in, the host patches itself: unattended
 * security upgrades daily, rebooting at 04:00 when a fix needs it (the egg container restarts with the server). Whoever launched the server keeps only provider-level
 * powers (stop/rebuild/delete), which is why a hatched gremlin moves out to a server under its own keys.
 */
import type { z } from 'zod'
import type { EggLaunchData, NestLaunchData } from './launch.js'

export interface CloudInitOptions {
  launch: Omit<z.input<typeof EggLaunchData>, 'image'> | Omit<z.input<typeof NestLaunchData>, 'image'>
  /** Release bundle of the same build, recorded so the gremlin can later move to Docker-less hosts. */
  artifact?: { url: string; sha256: string }
  /** Image reference pinned by digest, e.g. ghcr.io/org/egg@sha256:… */
  image: string
}

const DIGEST = /^[a-z0-9./_-]+(:[0-9]+)?(\/[a-z0-9._-]+)*@sha256:[0-9a-f]{64}$/

export function renderCloudInit(opts: CloudInitOptions): string {
  if (!DIGEST.test(opts.image)) throw new Error('egg image must be pinned by sha256 digest')
  const dev = opts.launch.dev
  for (const k of dev?.sshKeys ?? []) if (!/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [^\n']*)?$/.test(k)) throw new Error('dev ssh key is not a single-line public key')
  // The server records its own image so a gremlin can launch nests from the same build.
  const launchJson = JSON.stringify({ ...opts.launch, image: opts.image, ...(opts.artifact ? { artifact: opts.artifact } : {}) })
  // Dev gremlins: the team's keys log in as gremlinz-dev (sudo); nobody else can. Otherwise SSH is removed entirely.
  const access = dev
    ? `users:
  - name: gremlinz-dev
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
${dev.sshKeys.map((k) => `      - '${k}'`).join('\n')}
`
    : ''
  const lockdown = dev
    ? `  - [sh, -c, 'rm -f /root/.ssh/authorized_keys; for d in /home/*/.ssh; do [ "$d" = /home/gremlinz-dev/.ssh ] || rm -f "$d/authorized_keys"; done']
  - [passwd, -l, root]`
    : `  - [sh, -c, 'systemctl disable --now ssh.service ssh.socket sshd.service 2>/dev/null || true']
  - [sh, -c, 'apt-get purge -y openssh-server || true']
  - [sh, -c, 'rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys']
  - [passwd, -l, root]`
  return `#cloud-config
package_update: true
packages: [docker.io, unattended-upgrades]
ssh_pwauth: false
disable_root: true
${access}write_files:
  - path: /etc/apt/apt.conf.d/52gremlin-auto-upgrades
    permissions: '0644'
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
      Unattended-Upgrade::Automatic-Reboot "true";
      Unattended-Upgrade::Automatic-Reboot-Time "04:00";
  - path: /etc/gremlin/launch.json
    permissions: '${opts.launch.mode === 'nest' ? '0600' : '0644'}'
    content: '${launchJson.replace(/'/g, "''")}'
runcmd:
${lockdown}
  - [chown, '1000:1000', /etc/gremlin/launch.json]
  - [mkdir, -p, /var/lib/gremlin]
  - [chown, '1000:1000', /var/lib/gremlin]
  - [chmod, '700', /var/lib/gremlin]
  - [docker, run, -d, --name, egg, --restart, always, -v, '/var/lib/gremlin:/var/lib/gremlin', -v, '/etc/gremlin:/etc/gremlin:ro', '${opts.image}']
`
}
