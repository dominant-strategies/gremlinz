/**
 * Forge console (teardown phase 3): the identity header, the live readout cards and the subsystem list around the
 * stage. Every number here is read from the viewer state and forgePose, the same
 * source that moves the model, so nothing on screen can disagree with what the gremlin is doing. Nothing is typed in.
 */
import { view } from './forge-motion.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const pad = (n) => String(Math.floor(n)).padStart(2, '0')
const CELLS = 24
const MOVE_UNIT = { swing: '°', open: '°', curl: '°', spin: '°', slide: ' u', pulse: '%' }

let sp = null, born = performance.now() / 1000, operator = () => undefined
const hist = new Float32Array(160)
let histAt = 0, lastText = 0, shownBeat = -1

/** The gremlin's model code, like a product line: initials of its name and its part count (Octopod, 18 parts: OC-18). */
export function modelCode(spec) {
  const letters = (spec.name || 'Gremlin').toUpperCase().replace(/[^A-Z]/g, '')
  const second = letters.slice(1).replace(/[AEIOU]/g, '')[0] || letters[1] || 'X'
  return `${letters[0] || 'G'}${second}-${spec.parts.length}`
}
/** A short stable id for the design, so two looks at the same spec read the same. */
function designId(spec) {
  let h = 2166136261
  for (const ch of JSON.stringify(spec.parts)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return `GF-${(h >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4)}`
}
const jointed = () => (sp?.assemblies || []).filter((a) => a.joint)

/** The name field is as wide as the name, so the slash sits right after it (field-sizing where supported, size otherwise). */
export function fitName() { const n = $('name'); n.size = Math.max(3, Math.min(28, (n.value || '').length + 1)) }
export function mountHud(opts) {
  operator = opts.operator
  $('name').addEventListener('input', fitName)
  $('hudCells').innerHTML = Array.from({ length: CELLS }, () => '<i></i>').join('')
}

/** Rebuilds the parts of the console that depend on the design. */
export function renderHud(spec) {
  sp = spec
  fitName()
  const asms = spec.assemblies || [], modes = (spec.modes || []).filter((m) => m.id !== 'idle')
  $('hudCode').textContent = modelCode(spec)
  $('hudId').textContent = designId(spec)
  const kind = spec.menace >= 7 ? 'Hostile' : spec.menace >= 4 ? 'Working' : 'Friendly'
  $('hudKicker').textContent = `${kind} gremlin · ${asms.length} assembl${asms.length === 1 ? 'y' : 'ies'} · ${modes.length} mode${modes.length === 1 ? '' : 's'}`
  $('hudJoints').innerHTML = jointed().length
    ? jointed().map((a) => `<li data-asm="${esc(a.id)}"><span class="n">${esc(a.name)}</span><span class="v">0</span><i><b></b></i></li>`).join('')
    : '<li class="none">No moving joints in this design.</li>'
  $('hudSubs').innerHTML = asms.map((a, i) => `<li data-asm="${esc(a.id)}"><span class="ix">${pad(i + 1)}</span><span class="nm"><b>${esc(a.name)}</b><small>${esc(a.role || '')}</small></span><span class="pill">${esc(a.states[0])}</span></li>`).join('')
  shownBeat = -1
}

/** Per frame: the sparkline; ten times a second: every number and pill. */
export function tickHud(now) {
  if (!sp) return
  const pose = view.pose || {}, js = jointed()
  const load = js.length ? js.reduce((s, a) => s + Math.abs(pose[a.id]?.drive || 0), 0) / js.length : 0
  if (now - histAt > 1 / 20) { histAt = now; hist.copyWithin(0, 1); hist[hist.length - 1] = Math.max(load, view.explode * 0.5) }
  drawSpark()
  if (view.tour) moveCursor()
  if (now - lastText < 0.1) return
  lastText = now
  const mode = sp.modes?.find((m) => m.id === view.mode), up = view.mode !== 'idle' && view.input > 0.005
  // header
  const pct = Math.round(load * 100)
  $('hudLoad').textContent = `${pct}%`
  const lit = Math.round(load * CELLS)
  ;[...$('hudCells').children].forEach((c, i) => { c.className = i < lit ? (i >= CELLS * 0.8 ? 'hot' : 'on') : '' })
  const status = $('stage').classList.contains('working') ? 'Working' : up ? mode?.name : view.explode > 0.02 ? 'Exploded' : view.isolate ? 'Isolated' : 'Idle'
  $('hudStatus').lastChild.textContent = String(status).toUpperCase()
  $('hudStatus').classList.toggle('on', status !== 'Idle')
  $('hudClock').textContent = (() => { const t = now - born; return `${pad(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)}` })()
  const who = operator()
  $('hudOperator').textContent = who ? `${who.slice(0, 6)}…${who.slice(-4)}` : 'Guest'
  // drive card
  $('hudDrive').textContent = String(up ? Math.round(view.input * 100) : pct)
  $('hudDriveMode').textContent = up ? `${mode?.name} · input` : 'Idle · drive load'
  $('hudInput').textContent = view.input.toFixed(2)
  $('hudExplode').textContent = `${Math.round(view.explode * 100)}%`
  // joints: value in the joint's own unit, bar as a share of its range
  for (const li of $('hudJoints').querySelectorAll('li[data-asm]')) {
    const a = sp.assemblies.find((x) => x.id === li.dataset.asm), p = pose[li.dataset.asm]
    if (!a || !p) continue
    const unit = MOVE_UNIT[a.joint.move]
    const shown = a.joint.move === 'pulse' ? Math.round(p.value * 100) : a.joint.move === 'slide' ? p.value.toFixed(2) : Math.round(p.value)
    li.querySelector('.v').textContent = `${shown}${unit}`
    const share = a.joint.move === 'spin' ? Math.abs(p.drive) : Math.min(1, Math.abs(p.value / (a.joint.range || 1)))
    li.querySelector('b').style.width = `${Math.round(share * 100)}%`
    li.classList.toggle('on', p.active)
  }
  for (const li of $('hudSubs').children) {
    const p = pose[li.dataset.asm]; if (!p) continue
    const pill = li.querySelector('.pill')
    pill.textContent = p.status
    pill.classList.toggle('on', Math.abs(p.drive) > 0.5)
    li.classList.toggle('focus', view.isolate === li.dataset.asm)
  }
}

function drawSpark() {
  const c = $('hudSpark'), w = c.clientWidth, h = c.clientHeight
  if (!w || !h) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
  g.strokeStyle = 'rgba(36,33,29,.09)'; g.lineWidth = 1
  for (const y of [0.25, 0.5, 0.75]) { g.beginPath(); g.moveTo(0, h * y); g.lineTo(w, h * y); g.stroke() }
  const n = hist.length, x = (i) => (i / (n - 1)) * (w - 6), y = (v) => h - 4 - v * (h - 10)
  g.beginPath(); g.moveTo(x(0), y(hist[0]))
  for (let i = 1; i < n; i++) g.lineTo(x(i), y(hist[i]))
  g.strokeStyle = '#e8571e'; g.lineWidth = 1.6; g.stroke()
  g.lineTo(x(n - 1), h); g.lineTo(0, h); g.closePath(); g.fillStyle = 'rgba(232,87,30,.08)'; g.fill()
  g.beginPath(); g.arc(x(n - 1), y(hist[n - 1]), 3, 0, Math.PI * 2); g.fillStyle = '#e8571e'; g.fill()
}

/** During the tour a cursor walks to the button for each step and presses it, so the tour reads as someone driving. */
function moveCursor() {
  if (view.beat === shownBeat) return
  const prev = view.beats[shownBeat], b = view.beats[view.beat]
  shownBeat = view.beat
  if (!b || (prev && prev.label === b.label)) return
  const target = b.mode !== 'idle' ? document.querySelector(`#modeChips button[data-mode="${CSS.escape(b.mode)}"]`)
    : b.label === 'Exploded' ? $('dExplode') : null
  const cur = $('hudCursor'), hud = $('hud').getBoundingClientRect()
  const r = (target || $('stage')).getBoundingClientRect()
  const x = target ? r.left + r.width * 0.6 : r.left + r.width * 0.55, y = target ? r.top + r.height * 0.6 : r.top + r.height * 0.45
  cur.style.transform = `translate(${x - hud.left}px, ${y - hud.top}px)`
  cur.classList.add('show')
  if (target) setTimeout(() => { cur.classList.add('press'); setTimeout(() => cur.classList.remove('press'), 260) }, 650)
}
export function hideCursor() { $('hudCursor')?.classList.remove('show'); shownBeat = -1 }
