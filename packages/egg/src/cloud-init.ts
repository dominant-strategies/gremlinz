/**
 * cloud-init user data for an egg server. Browser-safe (pure string building) so the launch page can use it.
 *
 * The server is locked down before the egg starts: SSH is removed, root's password is locked and any
 * provider-injected authorized_keys are deleted. Whoever launched the server keeps only provider-level
 * powers (stop/rebuild/delete), which is why a hatched gremlin moves out to a server under its own keys.
 */
import type { LaunchData } from './launch.js'

export interface CloudInitOptions {
  launch: LaunchData
  /** Image reference pinned by digest, e.g. ghcr.io/org/egg@sha256:… */
  image: string
}

const DIGEST = /^[a-z0-9./_-]+(:[0-9]+)?(\/[a-z0-9._-]+)*@sha256:[0-9a-f]{64}$/

export function renderCloudInit(opts: CloudInitOptions): string {
  if (!DIGEST.test(opts.image)) throw new Error('egg image must be pinned by sha256 digest')
  const launchJson = JSON.stringify(opts.launch)
  return `#cloud-config
package_update: true
packages: [docker.io]
ssh_pwauth: false
disable_root: true
write_files:
  - path: /etc/gremlin/launch.json
    permissions: '0644'
    content: '${launchJson.replace(/'/g, "''")}'
runcmd:
  - [sh, -c, 'systemctl disable --now ssh.service ssh.socket sshd.service 2>/dev/null || true']
  - [sh, -c, 'apt-get purge -y openssh-server || true']
  - [sh, -c, 'rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys']
  - [passwd, -l, root]
  - [mkdir, -p, /var/lib/gremlin]
  - [chown, '1000:1000', /var/lib/gremlin]
  - [chmod, '700', /var/lib/gremlin]
  - [docker, run, -d, --name, egg, --restart, always, -v, '/var/lib/gremlin:/var/lib/gremlin', -v, '/etc/gremlin:/etc/gremlin:ro', '${opts.image}']
`
}
