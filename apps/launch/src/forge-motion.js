/**
 * Forge motion: poses a built gremlin from forgePose (the one source of motion in @gremlins/hatch), and draws the
 * teardown views on top of it: exploded, isolate (everything else turns to a ghost), labels with leader lines, and the
 * self-running tour. The studio builds the scene graph (one node per assembly, with a pivot for its joint); this file
 * only moves it and owns the viewer state.
 */
import * as T from 'three'
import { forgePose, forgeTour, forgeTourAt } from '@gremlins/hatch'

const D = Math.PI / 180
const MODE_SECONDS = 1.1 // a mode's input travels 0 -> 1 in this long; forgePose eases it
const EXPLODE_SECONDS = 0.9

/** Viewer state. `input` and `explode` move toward their targets each frame, so every change animates. */
export const view = {
  mode: 'idle', input: 0, inputTo: 0, explode: 0, explodeTo: 0,
  isolate: null, labels: false, tour: false, tourStart: 0, beats: [], beat: -1,
  pose: {},
}

/** After a rebuild: back to rest, keeping the display toggles; isolate survives if its assembly still exists. */
export function resetView(spec) {
  const keep = (spec.assemblies || []).some((a) => a.id === view.isolate) ? view.isolate : null
  Object.assign(view, { mode: 'idle', input: 0, inputTo: 0, isolate: keep, beat: -1, beats: forgeTour(spec) })
  // one assembly: nothing to explode, label or tour, and the console is hidden, so nothing may be left switched on
  if ((spec.assemblies || []).length < 2) Object.assign(view, { explode: 0, explodeTo: 0, labels: false, tour: false })
}

/** Starts a mode, or lets it fall back to rest when it is already up. */
export function toggleMode(id) {
  view.tour = false
  if (view.mode === id && view.inputTo > 0) { view.inputTo = 0; return }
  if (view.mode !== id && view.input > 0.01) { view.mode = id; view.input = 0 } // jump: the eased pose starts from rest
  view.mode = id; view.inputTo = id === 'idle' ? 0 : 1
}
export function toggleExplode() { view.tour = false; view.explodeTo = view.explodeTo > 0 ? 0 : 1 }
export function toggleIsolate(id) { view.tour = false; view.isolate = view.isolate === id ? null : id }
export function startTour(now) { view.tour = true; view.tourStart = now; view.isolate = null }
/** Hands control back: whatever the tour was showing settles to rest. */
export function stopTour() {
  if (!view.tour) return
  Object.assign(view, { tour: false, inputTo: 0, explodeTo: 0, isolate: null })
}

/**
 * Advances the viewer by `dt` seconds at clock `t` and returns the pose input for forgePose. `still` holds the robot
 * at rest (while parts are being edited, so their numbers match what is on screen).
 */
export function step(spec, dt, t, still, reduceMotion) {
  if (still) return { mode: 'idle', input: 0, explode: 0, t: 0, idle: false }
  if (view.tour) {
    const s = forgeTourAt(view.beats, t - view.tourStart)
    Object.assign(view, { mode: s.mode, input: s.input, inputTo: s.input, explode: s.explode, explodeTo: s.explode, beat: s.beat })
    const m = spec.modes?.find((x) => x.id === s.mode)
    view.isolate = m?.focus && s.input > 0.25 ? m.focus : null
    return { mode: s.mode, input: s.input, explode: s.explode, t, idle: !reduceMotion }
  }
  const toward = (v, to, secs) => (v < to ? Math.min(to, v + dt / secs) : Math.max(to, v - dt / secs))
  view.input = reduceMotion ? view.inputTo : toward(view.input, view.inputTo, MODE_SECONDS)
  view.explode = reduceMotion ? view.explodeTo : toward(view.explode, view.explodeTo, EXPLODE_SECONDS)
  if (view.input === 0 && view.inputTo === 0) view.mode = 'idle'
  return { mode: view.mode, input: view.input, explode: view.explode, t, idle: !reduceMotion }
}

/** Applies a pose to the assembly nodes built by the studio. */
export function applyPose(rig, spec, poseIn) {
  const pose = forgePose(spec, poseIn)
  view.pose = pose
  for (const r of Object.values(rig)) {
    const p = pose[r.a.id]; if (!p) continue
    r.node.position.set(p.offset[0], p.offset[1], p.offset[2])
    const j = r.a.joint; if (!j) continue
    const v = p.value, [px, py, pz] = j.pivot
    r.main.pv.position.set(px, py, pz); r.main.pv.quaternion.identity(); r.main.pv.scale.setScalar(1)
    if (j.move === 'swing' || j.move === 'spin' || j.move === 'open') {
      r.main.pv.quaternion.setFromAxisAngle(r.axis, v * D)
      // the mirrored half of an "open" assembly turns the mirror-image way, so halves part like a clamshell
      if (r.mirror) r.mirror.pv.quaternion.setFromAxisAngle(r.mirrorAxis, -v * D)
    } else if (j.move === 'slide') {
      r.main.pv.position.addScaledVector(r.axis, v)
    } else if (j.move === 'pulse') {
      r.main.pv.scale.setScalar(1 + v)
    } else if (j.move === 'curl' && r.bends.length && Math.abs(v - r.bent) > 0.75) {
      r.bent = v
      for (const bend of r.bends) bend(v)
      ghosted = null // the bent limbs are new meshes: isolate has to reach them too
    }
  }
  return pose
}

// ---------------------------------------------------------------------------------------------------- isolate
const ghostMat = new T.MeshStandardMaterial({ color: '#d9d3c8', roughness: 0.6, transparent: true, opacity: 0.13, depthWrite: false })
let ghosted = null
/** Turns every assembly but `id` into a faint ghost (or restores them all when `id` is null). */
export function applyIsolate(rig, id) {
  const key = id || ''
  if (ghosted === key) return
  ghosted = key
  for (const r of Object.values(rig)) {
    const ghost = !!id && r.a.id !== id
    r.node.traverse((n) => {
      if (!n.isMesh || n.userData.overlay) return
      if (n.userData.mat0 === undefined) n.userData.mat0 = n.material
      n.material = ghost ? ghostMat : n.userData.mat0
      n.castShadow = !ghost
    })
  }
}
/** Call after a rebuild: the new meshes start solid. */
export function forgetIsolate() { ghosted = null }

// ---------------------------------------------------------------------------------------------------- labels
let layer = null
/** The HTML/SVG layer over the stage that holds labels and their leader lines. */
export function mountLabels(stage) {
  layer = document.createElement('div'); layer.className = 'labels'; layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML = '<svg class="leaders"></svg>'
  stage.appendChild(layer)
}
const v3 = new T.Vector3()
/**
 * Places a label per shown assembly at the side of the stage nearest its part, stacked so none overlap, with a thin
 * leader into the part. Active assemblies (driven by the current mode, or isolated) are drawn in the accent.
 */
export function drawLabels(rig, camera, w, h) {
  if (!layer) return
  const svg = layer.firstChild
  const show = Object.values(rig).filter((r) => (view.labels || view.isolate === r.a.id) && r.anchor && (view.isolate == null || view.isolate === r.a.id))
  const items = show.map((r) => {
    r.anchor.getWorldPosition(v3).project(camera)
    const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h
    const p = view.pose[r.a.id]
    return { r, x, y, left: x < w / 2, active: !!p?.active || view.isolate === r.a.id, status: p?.status || r.a.states[0] }
  })
  // stack each side top to bottom, at least 46px apart, inside the stage
  for (const side of [true, false]) {
    const col = items.filter((i) => i.left === side).sort((a, b) => a.y - b.y)
    let last = 24
    for (const it of col) { it.ly = Math.max(last, Math.min(h - 70, it.y)); last = it.ly + 46 }
  }
  const seen = new Set()
  for (const it of items) {
    const id = it.r.a.id; seen.add(id)
    let el = layer.querySelector(`[data-asm="${id}"]`)
    if (!el) {
      el = document.createElement('div'); el.className = 'lbl'; el.dataset.asm = id
      el.innerHTML = '<b></b><span></span>'
      layer.appendChild(el)
    }
    el.firstChild.textContent = it.r.a.name
    el.lastChild.textContent = it.status
    el.classList.toggle('on', it.active)
    el.classList.toggle('right', !it.left)
    el.style.top = `${it.ly}px`
    it.lx = it.left ? 16 + el.offsetWidth : w - 16 - el.offsetWidth
  }
  for (const el of layer.querySelectorAll('.lbl')) if (!seen.has(el.dataset.asm)) el.remove()
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.innerHTML = items.map((it) => {
    const y0 = it.ly + 16, x1 = it.left ? it.lx + 6 : it.lx - 6, elbow = it.left ? Math.min(it.x - 14, x1 + 28) : Math.max(it.x + 14, x1 - 28)
    const cls = it.active ? ' class="on"' : ''
    return `<polyline${cls} points="${x1},${y0} ${elbow},${y0} ${it.x},${it.y}"/><circle${cls} cx="${it.x}" cy="${it.y}" r="3.5"/>`
  }).join('')
}
