/**
 * cloud-init user data for an egg server. Browser-safe (pure string building) so the launch page can use it.
 *
 * Nobody may get into an egg's server: not the maker, not whoever holds the hosting account, not us (except dev
 * gremlins, below). gremlin-lockdown enforces that on every boot, before the network comes up, and after every package
 * change: it deletes every authorized_keys file, masks every console login (serial included), locks root, disables
 * cloud-init after the first boot (so changed provider metadata can't inject keys or scripts later), masks sshd and
 * locks the boot menu (no recovery entry, no editing: a random superuser password nobody keeps; normal boot stays
 * unrestricted). SSH itself is purged.
 *
 * Dev gremlins (launch data `dev`) keep SSH for the team's keys only: sshd reads keys from one root-owned file and lets
 * only gremlinz-dev in, so keys planted in home directories (e.g. via provider metadata) are ignored.
 *
 * With nobody left to log in, the host patches itself: unattended security upgrades daily, rebooting at 04:00 when a
 * fix needs it (the egg container restarts with the server).
 */
import type { z } from 'zod'
import { GREMLIN_UNIT, WATCHDOG_SCRIPT, WATCHDOG_TIMER, WATCHDOG_UNIT } from './systemd.js'
import type { EggLaunchData, NestLaunchData } from './launch.js'

export interface CloudInitOptions {
  launch: Omit<z.input<typeof EggLaunchData>, 'image'> | Omit<z.input<typeof NestLaunchData>, 'image'>
  /** Release bundle of the same build, recorded so the gremlin can later move to Docker-less hosts. */
  artifact?: { url: string; sha256: string }
  /** Image reference pinned by digest, e.g. ghcr.io/org/egg@sha256:… */
  image: string
}

const DIGEST = /^[a-z0-9./_-]+(:[0-9]+)?(\/[a-z0-9._-]+)*@sha256:[0-9a-f]{64}$/

/** Runs on every boot before networking (gremlin-lockdown.service) and after every dpkg run. Idempotent. */
export const LOCKDOWN_SCRIPT = String.raw`#!/bin/sh
# gremlin-lockdown: nobody but the team's dev keys (if this is a dev gremlin) can get into this server.
set -u
DEV_KEYS=/etc/ssh/gremlinz_dev_keys

# Keys: none anywhere, including any that systemd-tmpfiles wrote from hypervisor credentials this boot (we run after it).
# Dev access reads only $DEV_KEYS (sshd drop-in), never a home directory.
rm -f /root/.ssh/authorized_keys /root/.ssh/authorized_keys2
for d in /home/*/.ssh; do rm -f "$d/authorized_keys" "$d/authorized_keys2"; done

# Logins: no console prompts (virtual, serial, hypervisor), no root password, no magic SysRq.
systemctl mask getty@.service serial-getty@.service console-getty.service container-getty@.service >/dev/null 2>&1
systemctl stop 'getty@*' 'serial-getty@*' >/dev/null 2>&1
passwd -l root >/dev/null 2>&1
sysctl -q -w kernel.sysrq=0 2>/dev/null
# systemd-ssh-generator's extra sshd sockets (vsock, local AF_UNIX) take keys from a hypervisor-supplied credential
# (ssh.authorized_keys.root) and override AuthorizedKeysFile: never, dev or not.
systemctl mask --now sshd-vsock.socket sshd-unix-local.socket sshd-unix-export.socket >/dev/null 2>&1
[ -s "$DEV_KEYS" ] || systemctl mask --now ssh.service ssh.socket sshd.service >/dev/null 2>&1

# Provider metadata never runs again: cloud-init did its one job on first boot.
mkdir -p /etc/cloud && touch /etc/cloud/cloud-init.disabled

# Boot menu: no editing or recovery without a password nobody kept. Normal boot stays unrestricted; if that ever can't
# be guaranteed, the lock is dropped rather than leave a server that can't boot.
if command -v update-grub >/dev/null 2>&1 && command -v grub-mkpasswd-pbkdf2 >/dev/null 2>&1 && [ -e /etc/grub.d/10_linux ]; then
  changed=
  if [ ! -x /etc/grub.d/01_gremlin_lockdown ]; then
    pw=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')
    hash=$(printf '%s\n%s\n' "$pw" "$pw" | grub-mkpasswd-pbkdf2 2>/dev/null | awk '/grub\.pbkdf2/ {print $NF}')
    pw=
    if [ -n "$hash" ]; then
      printf '#!/bin/sh\ncat <<EOF\nset superusers="gremlin-lockdown"\npassword_pbkdf2 gremlin-lockdown %s\nEOF\n' "$hash" > /etc/grub.d/01_gremlin_lockdown
      chmod 755 /etc/grub.d/01_gremlin_lockdown
      changed=1
    fi
  fi
  if ! grep -q -- '--unrestricted' /etc/grub.d/10_linux; then
    sed -i 's/^CLASS="\(.*\)"$/CLASS="\1 --unrestricted"/' /etc/grub.d/10_linux
    changed=1
  fi
  if [ ! -e /etc/default/grub.d/99-gremlin-lockdown.cfg ]; then
    mkdir -p /etc/default/grub.d
    printf 'GRUB_TIMEOUT=0\nGRUB_TIMEOUT_STYLE=hidden\nGRUB_RECORDFAIL_TIMEOUT=0\nGRUB_DISABLE_RECOVERY=true\nGRUB_DISABLE_OS_PROBER=true\n' > /etc/default/grub.d/99-gremlin-lockdown.cfg
    changed=1
  fi
  cfg=/boot/grub/grub.cfg
  [ -n "$changed" ] && update-grub >/dev/null 2>&1
  if grep -q superusers "$cfg" 2>/dev/null && ! grep -m1 '^menuentry ' "$cfg" | grep -q -- '--unrestricted'; then
    rm -f /etc/grub.d/01_gremlin_lockdown
    update-grub >/dev/null 2>&1
  fi
fi
exit 0
`

const LOCKDOWN_UNIT = `[Unit]
Description=Gremlin lockdown: no keys, console logins or boot-menu edits for anyone
DefaultDependencies=no
After=local-fs.target systemd-tmpfiles-setup.service
Before=network-pre.target sysinit.target getty.target ssh.service cloud-init-local.service shutdown.target
Wants=network-pre.target
# Stopped (so ExecStop runs) on the way down, while /boot is still mounted.
Conflicts=shutdown.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/gremlin-lockdown
# Again at shutdown, so a reboot (e.g. unattended-upgrades at 04:00) never meets a boot menu that wants the password.
ExecStop=/usr/local/sbin/gremlin-lockdown
RemainAfterExit=yes

[Install]
WantedBy=sysinit.target
`

const SSHD_DEV = `AuthorizedKeysFile /etc/ssh/gremlinz_dev_keys
AuthorizedKeysCommand none
AllowUsers gremlinz-dev
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
`

/** A file entry for write_files with literal content (YAML block scalar, so nothing in it needs escaping). */
const file = (path: string, mode: string, content: string) =>
  `  - path: ${path}\n    permissions: '${mode}'\n    content: |\n${content.replace(/\n$/, '').split('\n').map((l) => (l ? `      ${l}` : '')).join('\n')}\n`

export function renderCloudInit(opts: CloudInitOptions): string {
  if (!DIGEST.test(opts.image)) throw new Error('egg image must be pinned by sha256 digest')
  const dev = opts.launch.dev
  for (const k of dev?.sshKeys ?? []) if (!/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [^\n']*)?$/.test(k)) throw new Error('dev ssh key is not a single-line public key')
  // The server records its own image so a gremlin can launch nests from the same build.
  const launchJson = JSON.stringify({ ...opts.launch, image: opts.image, ...(opts.artifact ? { artifact: opts.artifact } : {}) })
  // Dev gremlins: the team's keys log in as gremlinz-dev (sudo); sshd reads them from one root-owned file.
  const access = dev
    ? `users:
  - name: gremlinz-dev
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
`
    : ''
  const devFiles = dev
    ? file('/etc/ssh/gremlinz_dev_keys', '0644', dev.sshKeys.join('\n') + '\n') + file('/etc/ssh/sshd_config.d/00-gremlinz-dev.conf', '0644', SSHD_DEV)
    : ''
  const lockdown = `  - [systemctl, daemon-reload]
  - [systemctl, enable, gremlin-lockdown.service]
  - [/usr/local/sbin/gremlin-lockdown]
${dev
    ? `  - [sh, -c, 'systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service 2>/dev/null || true']`
    : `  - [sh, -c, 'systemctl disable --now ssh.service ssh.socket sshd.service 2>/dev/null || true']
  - [sh, -c, 'apt-get purge -y openssh-server || true']`}`
  return `#cloud-config
package_update: true
packages: [docker.io, unattended-upgrades]
ssh_pwauth: false
disable_root: true
${access}write_files:
${file('/usr/local/sbin/gremlin-lockdown', '0755', LOCKDOWN_SCRIPT)}${file('/etc/systemd/system/gremlin-lockdown.service', '0644', LOCKDOWN_UNIT)}${file('/etc/systemd/system/gremlin.service', '0644', GREMLIN_UNIT)}${file('/etc/systemd/system/gremlin-watchdog.service', '0644', WATCHDOG_UNIT)}${file('/etc/systemd/system/gremlin-watchdog.timer', '0644', WATCHDOG_TIMER)}${file('/usr/local/sbin/gremlin-watchdog', '0755', WATCHDOG_SCRIPT)}${file('/etc/gremlin/service.env', '0600', `GREMLIN_IMAGE=${opts.image}\n`)}${file('/etc/apt/apt.conf.d/99gremlin-lockdown', '0644', 'DPkg::Post-Invoke { "/usr/local/sbin/gremlin-lockdown >/dev/null 2>&1 || true"; };\n')}${devFiles}  - path: /etc/apt/apt.conf.d/52gremlin-auto-upgrades
    permissions: '0644'
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
      Unattended-Upgrade::Automatic-Reboot "true";
      Unattended-Upgrade::Automatic-Reboot-Time "04:00";
  - path: /etc/gremlin/launch.json
    permissions: '${opts.launch.mode === 'nest' || ('hatch' in opts.launch && opts.launch.hatch) ? '0600' : '0644'}'
    content: '${launchJson.replace(/'/g, "''")}'
runcmd:
${lockdown}
  - [chown, '1000:1000', /etc/gremlin/launch.json]
  - [mkdir, -p, /var/lib/gremlin]
  - [chown, '1000:1000', /var/lib/gremlin]
  - [chmod, '700', /var/lib/gremlin]
  - [mkdir, -p, /var/lib/gremlin-hermes]
  - [chmod, '700', /var/lib/gremlin-hermes]
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, gremlin.service, gremlin-watchdog.timer]
`
}
