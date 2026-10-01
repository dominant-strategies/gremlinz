import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { EggState, StateStore } from './egg.js'

/** JSON file store with atomic replace, so a crash mid-write never corrupts state. */
export function fileStore(path: string): StateStore {
  return {
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as EggState) : undefined),
    save: (state) => {
      writeFileSync(path + '.tmp', JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 })
      renameSync(path + '.tmp', path)
    },
  }
}

export function memoryStore(initial?: EggState): StateStore & { state?: EggState } {
  const s: StateStore & { state?: EggState } = {
    state: initial,
    load: () => s.state,
    save: (state) => { s.state = state },
  }
  return s
}
