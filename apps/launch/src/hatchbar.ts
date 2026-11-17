/**
 * The hatch's step bar: one row of numbered stages, always in the same place (under the site header, above the Forge
 * pane), from signing in to hatching. Every stage you've reached is a button: before the egg is rented you can go back
 * and change anything; after, the config is fixed in the egg's launch data, so earlier stages open read-only.
 */
import type { BuildStep, Session } from './session.js'

export const STAGES = ['connect', 'name', 'look', 'persona', 'models', 'rules', 'host', 'fund', 'hatch'] as const
export type Stage = (typeof STAGES)[number]
export const STAGE_TITLE: Record<Stage, string> = {
  connect: 'Sign in', name: 'Name', look: 'Body', persona: 'Personality', models: 'Models', rules: 'Rules', host: 'Host', fund: 'Fund', hatch: 'Hatch',
}
const BUILD: readonly Stage[] = ['name', 'look', 'persona', 'models', 'rules']
export const isBuild = (x: Stage): x is BuildStep => BUILD.includes(x)

type View = Pick<Session, 'maker' | 'config' | 'at' | 'host' | 'hatch' | 'machineId'>

/** Where the hatch actually is (what route() would show). */
export function currentStage(s: View): Stage {
  if (!s.maker) return 'connect'
  if (!s.config) return s.at ?? 'name'
  if (!s.host) return 'host'
  if (!s.machineId) return 'fund'
  return 'hatch'
}

/** The egg is being (or has been) rented for this config: it can't change any more. Funding starts the moment a host is chosen. */
export const locked = (s: View) => !!(s.hatch || s.machineId || (s.config && s.host))

export type StageState = { stage: Stage; n: number; state: 'done' | 'now' | 'todo'; viewing: boolean; open: boolean; readOnly: boolean }

/**
 * Each stage as the bar draws it. `isDone`: the progress window's record (lets you jump forward again to builder steps
 * you'd already finished). `viewing`: a stage being reviewed instead of the current one.
 */
export function stageStates(s: View, isDone: (id: string) => boolean, viewing?: Stage): StageState[] {
  const now = currentStage(s)
  const at = STAGES.indexOf(now)
  return STAGES.map((stage, i) => {
    const done = i < at || (i > at && !s.config && isBuild(stage) && isDone(stage))
    // while building, you can also jump ahead to any builder step whose earlier steps were all finished (as far as you got)
    const ahead = !!s.maker && i > at && !s.config && isBuild(stage) && BUILD.slice(0, BUILD.indexOf(stage)).every((b) => isDone(b))
    const open = stage === now || done || ahead
    // signing in and (once rented) everything you configured can be looked at, not changed
    const readOnly = open && stage !== now && (stage === 'connect' || (locked(s) && i < at))
    return { stage, n: i + 1, state: stage === now ? 'now' : done ? 'done' : 'todo', viewing: (viewing ?? now) === stage, open, readOnly }
  })
}

export function hatchbarHtml(states: StageState[]): string {
  const item = (x: StageState) => {
    const label = `<span class="hb-n">${x.state === 'done' ? '✓' : x.n}</span><span class="hb-t">${STAGE_TITLE[x.stage]}</span>`
    const cls = `hb-${x.state}${x.viewing ? ' hb-view' : ''}`
    const title = x.state === 'todo' ? 'Not yet' : x.readOnly ? `${STAGE_TITLE[x.stage]} (view only: the egg is rented with this)` : x.state === 'now' ? `${STAGE_TITLE[x.stage]} (you are here)` : `Back to ${STAGE_TITLE[x.stage]}`
    return `<li class="${cls}">${x.open
      ? `<button type="button" data-stage="${x.stage}" title="${title}"${x.viewing ? ' aria-current="step"' : ''}>${label}</button>`
      : `<span class="hb-off" title="${title}" aria-disabled="true">${label}</span>`}</li>`
  }
  return `<ol>${states.map(item).join('')}</ol>`
}

export const HATCHBAR_CSS = `
.hatchbar { position: sticky; top: var(--hb-top, 64px); z-index: 19; background: color-mix(in srgb, var(--paper) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
body.pane-open .hatchbar { z-index: 60; }
.hatchbar ol { list-style: none; display: flex; gap: 4px; width: fit-content; max-width: 100%; margin: 0 auto; padding: 10px 20px; overflow-x: auto; scrollbar-width: none; counter-reset: none; }
.hatchbar li { flex: 0 0 auto; display: flex; align-items: center; }
.hatchbar li + li::before { content: ''; flex: 0 0 20px; height: 1.5px; margin-right: 4px; background: var(--line); }
.hatchbar li.hb-done + li::before, .hatchbar li.hb-now::before { background: var(--ink); }
.hatchbar button, .hatchbar .hb-off { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 12px 4px 4px; border-radius: 999px; border: 1.5px solid transparent; font: 700 14px/1 var(--display); white-space: nowrap; }
.hatchbar button { cursor: pointer; color: var(--ink); transition: background-color .12s, border-color .12s; }
.hatchbar button:hover { background: var(--field); border-color: var(--ink); }
.hatchbar button:focus-visible { outline: 2px solid var(--moss); outline-offset: 2px; }
.hatchbar .hb-off { color: var(--ink-2); opacity: .55; cursor: default; }
.hatchbar .hb-n { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid currentColor; font: 800 13px var(--mono); }
.hatchbar .hb-done .hb-n { background: var(--ink); border-color: var(--ink); color: #f7f3ec; }
.hatchbar .hb-now .hb-n { background: var(--moss); border-color: var(--ink); color: #f7f3ec; }
.hatchbar .hb-view button { border-color: var(--ink); background: var(--card); text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }
@media (max-width: 899px) { .hatchbar li:not(.hb-view) .hb-t { display: none; } .hatchbar button, .hatchbar .hb-off { padding-right: 4px; } .hatchbar .hb-view button { padding-right: 12px; } }
.review { display: grid; gap: 14px; }
.review .ro { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0; padding: 10px 14px; border: 1.5px dashed var(--line); border-radius: 12px; font-size: 14px; color: var(--ink-2); }
.review dl { display: grid; gap: 4px 16px; grid-template-columns: max-content minmax(0, 1fr); margin: 0; }
.review dt { font: 600 12px/1.6 var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.review dd { margin: 0; overflow-wrap: anywhere; }
.review img { width: 160px; height: 160px; border-radius: 16px; border: 1.5px solid var(--line); }
`
