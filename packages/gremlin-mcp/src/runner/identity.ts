import { readFileSync } from 'node:fs'

/** Linux boot id and process birth time protect cleanup against PID reuse after a crash/reboot. */
export function processIdentity(pid: number): { pid: number; boot: string; born: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const born = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]
    if (!born) return undefined
    return { pid, boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), born }
  } catch { return undefined }
}

export function sameProcess(record: ReturnType<typeof processIdentity>): boolean {
  if (!record) return false
  const current = processIdentity(record.pid)
  return !!current && current.boot === record.boot && current.born === record.born
}
