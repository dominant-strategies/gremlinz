/** Public keys bundled with the release for explicitly selected team development access. */
export const TEAM_DEV_SSH_KEYS: readonly string[] = Object.freeze([
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMG/S4sEF8r2KvnrtvdaoN2ZyI6r7CMg8fiWLcEKHThX karl.kreder@gmail.com',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOeexySy6ckOJGAmzesLb40eoksOJoBL2C6I/q1A40sX gameofpointers@proton.me',
])

/** Normal launches remain off unless configured; canaries select the team profile by default. */
export function devSshKeys(setting?: string): string[] {
  if (setting?.trim() === 'team') return [...TEAM_DEV_SSH_KEYS]
  return String(setting ?? '').split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
}
