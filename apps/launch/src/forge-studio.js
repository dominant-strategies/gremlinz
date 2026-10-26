/**
 * Gremlin Forge page: Claude designs a gremlin's whole 3D body (via the board's /api/forge/design), the browser builds
 * and renders it in the enamel-and-chrome studio, and an image model repaints the render as a studio photograph
 * (via /api/forge/photo). Weathering and decals are painted on by forge-surfaces.js. Every change is a step in a
 * branching history: going back to a step and changing something starts a new branch, and no step is ever dropped.
 * The design language and the house-style checker are shared in @gremlins/hatch.
 */
import * as T from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { FORGE_DECAL_FINISHES, FORGE_EXAMPLES, FORGE_STYLE, FORGE_WEAR, checkForgeSpec } from '@gremlins/hatch'
import { addDecals, artReady, wearFor, wearFrame, wearMaterial } from './forge-surfaces.js'
import { creatureSvg } from '@gremlins/hatch/creature'
import { signIn, signOut, signedInAddress, signedPostJson } from './forge-auth.ts'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const ENAMELS = [['#efe3c8', 'Cream'], ['#a8c8e0', 'Pastel blue'], ['#a9d8c4', 'Pastel green'], ['#f1b9c4', 'Rosa'], ['#c9302c', 'Rosso'], ['#e5b54a', 'Mustard'], ['#5b6168', 'Gunmetal'], ['#2b2b2e', 'Matte black']]
const GLOWS = [['#ffb347', 'Amber'], ['#7fe6ff', 'Cyan'], ['#9dff7a', 'Green'], ['#ff3b30', 'Red'], ['#c58bff', 'Violet']]
const IDEAS = [
  'A paranoid lighthouse keeper with a rotating searchlight head and too many arms',
  'A tiny tea-trolley butler that is far too eager to please',
  'A six-legged harvester that strips copper from old servers, all blades and pistons',
  'A jukebox-shaped crooner robot with a chrome pompadour',
]

// ---------------------------------------------------------------------------------------------------- state
// steps: [{ spec, house, label, parent, t, thumb?, photo? }], append-only; cur is the step on screen.
const MAX_STEPS = 80
const state = { steps: [], cur: -1, uploads: {} }
const redoTo = new Map() // step -> the child we last undid out of
try {
  const s = JSON.parse(localStorage.getItem('gremlins.forge') || 'null')
  if (s && Array.isArray(s.steps) && s.steps.length) { state.steps = s.steps.filter((x) => x && x.spec && Array.isArray(x.spec.parts)); state.cur = Math.min(Math.max(0, s.cur | 0), state.steps.length - 1) }
  else if (s && s.spec && Array.isArray(s.spec.parts)) { state.steps = [{ spec: s.spec, house: s.house || [], label: 'Saved design', parent: -1, t: Date.now() }]; state.cur = 0 }
} catch { /* private mode or bad data: start fresh */ }
try { state.uploads = JSON.parse(localStorage.getItem('gremlins.forge.uploads') || '{}') || {} } catch { /* none */ }
const step = () => state.steps[state.cur]
const spec = () => step()?.spec

function save() {
  const strip = (list) => list.map(({ photo: _p, ...x }) => x)
  for (const keep of [MAX_STEPS, 20, 5]) {
    const from = Math.max(0, state.steps.length - keep)
    try {
      localStorage.setItem('gremlins.forge', JSON.stringify({ steps: strip(rebase(state.steps.slice(from), from)), cur: Math.max(0, state.cur - from) }))
      return
    } catch { /* over quota: keep fewer */ }
  }
}
/** Re-points parents after dropping the first `from` steps. */
const rebase = (list, from) => (from ? list.map((x) => ({ ...x, parent: x.parent >= from ? x.parent - from : -1 })) : list)

/** Records a new step after the current one and shows it. */
function commit(nextSpec, house, label) {
  state.steps.push({ spec: nextSpec, house: house || [], label, parent: state.cur, t: Date.now() })
  state.cur = state.steps.length - 1
  if (state.steps.length > MAX_STEPS) {
    const drop = state.steps.length - MAX_STEPS
    state.steps = rebase(state.steps.slice(drop), drop); state.cur -= drop; redoTo.clear()
  }
  render(false)
}
function go(i, fresh) {
  if (i < 0 || i >= state.steps.length || i === state.cur) return
  state.cur = i; placing = null
  render(!!fresh)
}
function undo() {
  const s = step(); if (!s || s.parent < 0) return
  redoTo.set(s.parent, state.cur); go(s.parent)
}
function redoTarget() {
  const r = redoTo.get(state.cur)
  if (r != null && state.steps[r]?.parent === state.cur) return r
  for (let i = state.steps.length - 1; i > state.cur; i--) if (state.steps[i].parent === state.cur) return i
  return -1
}
function redo() { const r = redoTarget(); if (r >= 0) go(r) }
/** A deep copy of the current spec to edit into the next step. */
const draft = () => structuredClone(spec())
let caps = { design: false, photo: null }
let placing = null // { image } | { art } | { move: index } while waiting for a click on the robot
let lastSurface = { missed: 0, missingPictures: 0 }

// ---------------------------------------------------------------------------------------------------- studio
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
let renderer, scene, camera, controls, rig, robot = null, spin = !reduceMotion, glOK = false

function initStudio() {
  const stage = $('stage')
  try {
    renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  } catch {
    stage.insertAdjacentHTML('beforeend', '<div class="nogl">This browser can’t show the 3D render. The design spec below still updates.</div>')
    return
  }
  glOK = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = T.ACESFilmicToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = T.PCFSoftShadowMap
  renderer.domElement.className = 'studio'
  stage.prepend(renderer.domElement)
  scene = new T.Scene()
  scene.background = new T.Color('#d6ccbd')
  scene.environment = new T.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
  camera = new T.PerspectiveCamera(26, 1, 0.1, 80)
  controls = new OrbitControls(camera, renderer.domElement)
  Object.assign(controls, { enableDamping: true, enablePan: false, minDistance: 3, maxDistance: 14, maxPolarAngle: 1.5, minPolarAngle: 0.3 })
  // The backdrop and lights orbit with the camera, like a photographer walking round with the studio, so the paper
  // sweep is always behind the robot and never between it and the camera.
  rig = new T.Group(); scene.add(rig)
  const sweep = new T.Mesh(sweepGeometry(), new T.MeshStandardMaterial({ color: '#d6ccbd', roughness: 0.95 }))
  sweep.receiveShadow = true
  rig.add(sweep)
  const cv = document.createElement('canvas'); cv.width = cv.height = 128
  const cg = cv.getContext('2d'), grd = cg.createRadialGradient(64, 64, 4, 64, 64, 64)
  grd.addColorStop(0, 'rgba(0,0,0,0.5)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); cg.fillStyle = grd; cg.fillRect(0, 0, 128, 128)
  const blob = new T.Mesh(new T.PlaneGeometry(2.8, 2.8), new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), transparent: true, depthWrite: false }))
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.002; scene.add(blob)
  const key = new T.DirectionalLight('#fff4e6', 3.2); key.position.set(-3.5, 6.5, 5); key.castShadow = true
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -3.5, right: 3.5, top: 4.5, bottom: -1.5, near: 0.5, far: 22 })
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; rig.add(key); rig.add(key.target)
  const rim = new T.DirectionalLight('#dfe8ff', 1.6); rim.position.set(4, 3.5, -4); rig.add(rim); rig.add(rim.target)
  scene.add(new T.HemisphereLight('#fffaf0', '#8c8172', 0.35))
  new ResizeObserver(resize).observe(stage); resize()
  let down = null
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() } })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || !placing) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 500
    down = null
    if (moved < 6 && quick) placeAt(e)
  })
  renderer.setAnimationLoop(() => {
    if (document.hidden) return
    if (spin && robot && !placing) robot.rotation.y += 0.004
    controls.update()
    rig.rotation.y = controls.getAzimuthalAngle()
    if (robot) { robot.updateMatrixWorld(); wearFrame.value.copy(robot.matrixWorld).invert() }
    renderer.render(scene, camera)
  })
}
function resize() {
  const el = $('stage'), w = el.clientWidth, h = el.clientHeight
  if (!w || !h || !renderer) return
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
}
function sweepGeometry() {
  const prof = [[7, 0], [-2.2, 0]]
  for (let i = 1; i <= 16; i++) { const a = (i / 16) * Math.PI / 2; prof.push([-2.2 - Math.sin(a) * 2.2, 2.2 - Math.cos(a) * 2.2]) }
  prof.push([-4.4, 10])
  const pos = [], idx = []
  prof.forEach(([z, y]) => pos.push(-12, y, z, 12, y, z))
  for (let i = 0; i < prof.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals()
  return geo
}
function frame(fresh) {
  if (!robot || !camera) return
  const bb = new T.Box3().setFromObject(robot), size = new T.Vector3(), c = new T.Vector3(); bb.getSize(size); bb.getCenter(c)
  const dist = Math.max(5.4, Math.max(size.y, size.x * 0.85) * 2.55)
  const dir = fresh ? new T.Vector3(0.36, 0.17, 0.92).normalize() : new T.Vector3().subVectors(camera.position, controls.target).normalize()
  controls.target.set(0, Math.max(0.9, c.y), 0)
  camera.position.copy(controls.target).addScaledVector(dir, dist)
  controls.update()
}

// ---------------------------------------------------------------------------------------------------- materials + geometry
function materials(pal) {
  return {
    enamel: new T.MeshPhysicalMaterial({ color: pal.enamel, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 }),
    accent: new T.MeshPhysicalMaterial({ color: pal.accent, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 }),
    chrome: new T.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.06, envMapIntensity: 2.1 }),
    brass: new T.MeshStandardMaterial({ color: '#e0ad55', metalness: 1, roughness: 0.2, envMapIntensity: 1.6 }),
    copper: new T.MeshStandardMaterial({ color: '#d0805a', metalness: 1, roughness: 0.24, envMapIntensity: 1.5 }),
    glass: new T.MeshPhysicalMaterial({ color: '#0b1016', roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02 }),
    glow: new T.MeshBasicMaterial({ color: pal.glow, toneMapped: false }),
    rubber: new T.MeshStandardMaterial({ color: '#1e1f21', roughness: 0.85 }),
    steel: new T.MeshStandardMaterial({ color: '#3a3f45', metalness: 0.85, roughness: 0.38 }),
    ivory: new T.MeshPhysicalMaterial({ color: '#f4ecd8', roughness: 0.4, clearcoat: 0.6 }),
    __wear: new Map(),
  }
}
const D = Math.PI / 180
function mesh(geo, mat) { const m = new T.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; if (mat.userData.wear) m.userData.wear = mat.userData.wear; return m }
function taperedTube(curve, r0, r1, segs) {
  const g = new T.TubeGeometry(curve, segs, 1, 14, false), pos = g.attributes.position, ring = 15, p = new T.Vector3(), v = new T.Vector3()
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, p); const r = r0 + (r1 - r0) * (i / segs)
    for (let j = 0; j < ring; j++) { const k = i * ring + j; v.fromBufferAttribute(pos, k).sub(p).multiplyScalar(r).add(p); pos.setXYZ(k, v.x, v.y, v.z) }
  }
  pos.needsUpdate = true; g.computeVertexNormals(); return g
}
/** Gives one part its materials, weathered when the spec or the part asks for wear. */
function partMats(spec, p, M) {
  return (name) => {
    const layers = wearFor(spec, p, name)
    if (!layers.length || !M[name].isMeshStandardMaterial) return M[name]
    const key = name + JSON.stringify(layers)
    let m = M.__wear.get(key)
    if (!m) { m = wearMaterial(M[name], layers); m.userData.wear = layers; M.__wear.set(key, m) }
    return m
  }
}
function buildOne(p, M0, spec) {
  const g = new T.Group(), mat = partMats(spec, p, M0)
  const M = new Proxy(M0, { get: (o, k) => (typeof k === 'string' && k in o && k !== 'glow' && !k.startsWith('__') ? mat(k) : o[k]) })
  if (p.kind === 'lathe') {
    let pts = p.profile.map(([r, y]) => new T.Vector2(r, y))
    if (pts.length >= 3) pts = new T.SplineCurve(pts).getPoints(Math.min(120, pts.length * 12)).map((v) => new T.Vector2(Math.max(0, v.x), v.y))
    g.add(mesh(new T.LatheGeometry(pts, 96), M[p.mat]))
  } else if (p.kind === 'tube') {
    const curve = new T.CatmullRomCurve3(p.points.map((a) => new T.Vector3(a[0], a[1], a[2])))
    const segs = Math.max(12, Math.min(120, Math.round(curve.getLength() * 40)))
    const [r0, r1] = Array.isArray(p.radius) ? p.radius : [p.radius, p.radius]
    g.add(mesh(taperedTube(curve, r0, r1, segs), M[p.mat]))
    const c0 = mesh(new T.SphereGeometry(r0, 20, 14), M[p.mat]); c0.position.copy(curve.getPointAt(0)); g.add(c0)
    const c1 = mesh(new T.SphereGeometry(r1, 20, 14), M[p.mat]); c1.position.copy(curve.getPointAt(1)); g.add(c1)
    if (p.rings) {
      const pt = new T.Vector3(), tg = new T.Vector3(), ringMat = p.mat === 'chrome' ? M.steel : M.chrome
      for (let i = 1; i < p.rings; i++) {
        const u = i / p.rings; curve.getPointAt(u, pt); curve.getTangentAt(u, tg)
        const r = r0 + (r1 - r0) * u, ring = mesh(new T.TorusGeometry(r + 0.006, Math.max(0.006, r * 0.14), 8, 24), ringMat)
        ring.position.copy(pt); ring.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), tg); g.add(ring)
      }
    }
    return g // tubes are authored in world coordinates
  } else if (p.kind === 'extrude') {
    const s = new T.Shape(); p.shape.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); s.closePath()
    const geo = new T.ExtrudeGeometry(s, { depth: p.depth, bevelEnabled: p.bevel, bevelThickness: Math.min(0.02, p.depth * 0.3), bevelSize: Math.min(0.015, p.depth * 0.25), bevelSegments: 3, curveSegments: 12 })
    geo.translate(0, 0, -p.depth / 2); g.add(mesh(geo, M[p.mat]))
  } else if (p.kind === 'visor') {
    const r = p.h / 2, len = Math.max(0, p.w - p.h)
    const bez = mesh(new T.CapsuleGeometry(r + 0.035, len, 12, 40), M.chrome); bez.rotation.z = Math.PI / 2; bez.scale.set(1, 1, 0.34); bez.position.z = -0.02; g.add(bez)
    const gl = mesh(new T.CapsuleGeometry(r, len, 12, 40), M.glass); gl.rotation.z = Math.PI / 2; gl.scale.set(1, 1, 0.34); gl.position.z = 0.012; g.add(gl)
  } else if (p.kind === 'eye') {
    const s = p.size[0]; let m
    if (p.eye === 'dot') { m = mesh(new T.SphereGeometry(s, 24, 16), M.glow); m.scale.z = 0.35 }
    if (p.eye === 'pill') m = mesh(new T.CapsuleGeometry(s * 0.85, s * 1.2, 8, 16), M.glow)
    if (p.eye === 'bar') { m = mesh(new T.CapsuleGeometry(s * 0.45, s * 2.2, 8, 16), M.glow); m.rotation.z = Math.PI / 2 }
    if (p.eye === 'slit') m = mesh(new T.BoxGeometry(s * 3, s * 0.65, s * 0.4), M.glow)
    if (p.eye === 'ring') m = mesh(new T.TorusGeometry(s, s * 0.12, 8, 40), M.glow)
    if (p.eye === 'smile') { m = mesh(new T.TorusGeometry(s, s * 0.15, 8, 24, 1.7), M.glow); m.rotation.z = Math.PI + (Math.PI - 1.7) / 2 }
    m.castShadow = false; g.add(m); g.userData.glow = true
  } else {
    const s = p.size; let geo
    if (p.kind === 'sphere') geo = new T.SphereGeometry(s[0], 40, 28)
    if (p.kind === 'box') geo = new RoundedBoxGeometry(s[0], s[1], s[2], 3, Math.min(s[0], s[1], s[2]) * 0.18)
    if (p.kind === 'cylinder') geo = new T.CylinderGeometry(s[0], s[1], s[2], 40)
    if (p.kind === 'cone') geo = new T.ConeGeometry(s[0], s[1], 32)
    if (p.kind === 'torus') geo = new T.TorusGeometry(s[0], s[1], 16, 64, (p.arc || 360) * D)
    if (p.kind === 'capsule') geo = new T.CapsuleGeometry(s[0], s[1], 12, 32)
    g.add(mesh(geo, M[p.mat]))
  }
  g.position.set(p.pos[0], p.pos[1], p.pos[2])
  g.rotation.set(p.rot[0] * D, p.rot[1] * D, p.rot[2] * D)
  if (p.scale) g.scale.set(p.scale[0], p.scale[1], p.scale[2])
  return g
}
function expand(p, M, spec) {
  const base = buildOne(p, M, spec), out = new T.Group(), items = [base]
  if (p.mirror === 'x') { const mg = new T.Group(); mg.scale.x = -1; mg.add(base.clone()); items.push(mg) }
  const n = p.array ? p.array.count : 1
  for (let i = 0; i < n; i++) for (const it of items) {
    const g = new T.Group(); g.add(i === 0 ? it : it.clone())
    if (p.array && p.array.type === 'radial') g.rotation.y = (i / n) * Math.PI * 2
    if (p.array && p.array.type === 'linear') g.position.set(p.array.step[0] * i, p.array.step[1] * i, p.array.step[2] * i)
    out.add(g)
  }
  return out
}
function buildParts(spec, M) { const g = new T.Group(); spec.parts.forEach((p) => g.add(expand(p, M, spec))); return g }
function disposeTree(o) {
  const seen = new Set()
  o.traverse((n) => {
    if (n.geometry && !seen.has(n.geometry)) { seen.add(n.geometry); n.geometry.dispose() }
    if (n.material && !seen.has(n.material)) { seen.add(n.material); n.material.dispose() } // textures are cached in forge-surfaces
  })
}

// Geometric house rules: every gremlin has a face and some chrome trim.
function houseRules(spec, notes) {
  const hasFace = spec.parts.some((p) => p.kind === 'eye' || p.mat === 'glow')
  const hasTrim = spec.parts.some((p) => ['chrome', 'brass', 'copper'].includes(p.mat))
  if (hasFace && hasTrim) return
  const g = buildParts(spec, materials(spec.palette)); g.updateMatrixWorld(true)
  const bb = new T.Box3().setFromObject(g)
  if (!hasFace) {
    const h = bb.max.y - bb.min.y, y = bb.max.y - 0.22 * h
    const hit = new T.Raycaster(new T.Vector3(0, y, bb.max.z + 2), new T.Vector3(0, 0, -1)).intersectObject(g, true)[0]
    const z = hit ? hit.point.z : bb.max.z
    const w = Math.min(0.8, (bb.max.x - bb.min.x) * 0.6)
    spec.parts.push({ kind: 'visor', w, h: Math.min(0.44, w * 0.55), pos: [0, y, z - 0.04], rot: [0, 0, 0], house: true })
    spec.parts.push({ kind: 'eye', eye: 'pill', size: [0.05], pos: [w * 0.15, y + 0.01, z + 0.035], rot: [0, 0, 0], mirror: 'x', house: true })
    notes.push('No face found, so the house visor and eyes were added. Every gremlin has a face.')
  }
  if (!hasTrim) {
    let best = null
    for (const p of spec.parts) if (p.kind === 'lathe') { const mx = p.profile.reduce((a, b) => (b[0] > a[0] ? b : a)); if (!best || mx[0] > best.r) best = { r: mx[0], y: mx[1], p } }
    if (best) {
      spec.parts.push({ kind: 'torus', mat: 'chrome', size: [best.r + 0.01, 0.028], pos: [best.p.pos[0], best.p.pos[1] + best.y, best.p.pos[2]], rot: [90, 0, 0], house: true })
      notes.push('No chrome trim found, so a chrome band was added at the widest seam.')
    }
  }
  disposeTree(g)
}

let lastShapeKey = '', inner = null
function rebuild(fresh) {
  const sp = spec()
  if (!glOK || !sp) return
  const rot = robot ? robot.rotation.y : 0
  if (robot) { scene.remove(robot); disposeTree(robot) }
  inner = buildParts(sp, materials(sp.palette))
  const bb = new T.Box3().setFromObject(inner), size = new T.Vector3(), c = new T.Vector3(); bb.getSize(size); bb.getCenter(c)
  let s = Math.min(2.2, Math.max(0.4, 2.4 / Math.max(0.3, size.y)))
  if (size.x * s > 3.4) s = 3.4 / size.x
  const holder = new T.Group(); holder.scale.setScalar(s); holder.position.set(-c.x * s, -bb.min.y * s, -c.z * s); holder.add(inner)
  robot = new T.Group(); robot.add(holder)
  const glows = []; robot.updateMatrixWorld(true)
  lastSurface = addDecals(sp, inner, robot, state.uploads, s)
  robot.rotation.y = rot
  inner.traverse((n) => { if (n.userData.glow) glows.push(new T.Vector3().setFromMatrixPosition(n.matrixWorld)) })
  if (glows.length) {
    const avg = glows.reduce((a, b) => a.add(b), new T.Vector3()).multiplyScalar(1 / glows.length)
    const lamp = new T.PointLight(sp.palette.glow, 2.4, 1.8, 2); lamp.position.copy(avg).add(new T.Vector3(0, 0, 0.3)); robot.add(lamp)
  }
  scene.add(robot)
  const key = JSON.stringify(sp.parts).length + ':' + sp.parts.length
  if (fresh || key !== lastShapeKey) { lastShapeKey = key; frame(fresh) }
}

/** A square studio frame (1024×1024 PNG for the image model, small JPEGs for history) without disturbing the live view. */
function captureRender(size = 1024, type = 'image/png') {
  const canvas = renderer.domElement, w = canvas.width, h = canvas.height, ratio = renderer.getPixelRatio(), aspect = camera.aspect
  renderer.setPixelRatio(1); renderer.setSize(size, size, false); camera.aspect = 1; camera.updateProjectionMatrix()
  renderer.render(scene, camera)
  const data = canvas.toDataURL(type, 0.75)
  renderer.setPixelRatio(ratio); renderer.setSize(w / ratio, h / ratio, false); camera.aspect = aspect; camera.updateProjectionMatrix()
  renderer.render(scene, camera)
  return data
}
/** Thumbnails the step on screen once its decal art has drawn. */
function thumbLater() {
  const s = step(); if (!glOK || !s || s.thumb) return
  artReady().then(() => requestAnimationFrame(() => {
    if (step() !== s || s.thumb) return
    s.thumb = captureRender(112, 'image/jpeg'); renderHistory(); save()
  }))
}

// ---------------------------------------------------------------------------------------------------- placing decals
function placeAt(e) {
  if (!robot || !inner) return
  const r = renderer.domElement.getBoundingClientRect()
  const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
  const targets = []; inner.traverse((n) => { if (n.isMesh && !n.userData.glow) targets.push(n) })
  const hit = ray.intersectObjects(targets, false).find((h) => h.face)
  if (!hit) return setStatus('That missed the robot. Click on its body.', true)
  const toInner = new T.Matrix4().copy(inner.matrixWorld).invert()
  const at = hit.point.clone().applyMatrix4(toInner)
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(toInner)
  const r3 = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]
  const next = draft(), what = placing
  next.decals = next.decals || []
  if (what.move != null) {
    Object.assign(next.decals[what.move], { at: r3(at), dir: r3(n) })
    placing = null; commit(next, step().house, 'Moved a decal')
  } else {
    if (next.decals.length >= 12) { placing = null; renderSurfaces(); return setStatus('A gremlin can carry 12 decals at most. Remove one first.', true) }
    const d = { at: r3(at), dir: r3(n), size: 0.35, rot: 0, finish: 'paint' }
    if (what.image) d.image = what.image
    else { d.art = what.art }
    next.decals.push(d)
    placing = null; commit(next, step().house, `Placed ${what.image ? `“${state.uploads[what.image.slice(7)]?.label || 'picture'}”` : `“${what.art}”`}`)
  }
  setStatus('Placed. Adjust it under Decals.')
}
function startPlacing(p) {
  placing = p
  setStatus(p.move != null ? 'Click the robot where the decal should move to.' : 'Click the robot where it should go.')
  renderSurfaces()
}

// ---------------------------------------------------------------------------------------------------- uploads
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024
function saveUploads() {
  try { localStorage.setItem('gremlins.forge.uploads', JSON.stringify(state.uploads)) }
  catch { setStatus('This browser is out of room for pictures, so this one won’t be kept after you leave.', true) }
}
async function addUpload(file) {
  if (!file) return
  if (file.size > UPLOAD_MAX_BYTES) return setStatus('That picture is over 12 MB. Try a smaller one.', true)
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file isn’t a picture this browser can read.')); i.src = url })
    const w0 = img.naturalWidth || 512, h0 = img.naturalHeight || 512, k = Math.min(1, 768 / Math.max(w0, h0))
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k))
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
    const id = 'p' + Math.random().toString(36).slice(2, 8)
    const label = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'picture'
    state.uploads[id] = { label, data: cv.toDataURL('image/png'), aspect: cv.width / cv.height }
    saveUploads()
    startPlacing({ image: 'upload:' + id })
  } catch (e) { setStatus(e.message, true) } finally { URL.revokeObjectURL(url) }
}

// ---------------------------------------------------------------------------------------------------- board calls
let ctl = null
const setStatus = (t, err) => { const s = $('status'); s.textContent = t || ''; s.classList.toggle('err', !!err) }

async function generate(mode, text) {
  ctl = new AbortController(); busy(true, mode === 'new' ? 'Designing… this takes a minute or two.' : 'Reworking the design…')
  try {
    const body = { mode, text, care: $('care').checked }
    if (mode === 'refine') body.spec = spec()
    const ups = Object.entries(state.uploads).slice(0, 6).map(([id, u]) => ({ id, label: u.label }))
    if (ups.length) body.uploads = ups
    const res = await signedPostJson('/api/forge/design', body, ctl.signal)
    const { spec: next, notes } = checkForgeSpec(res.spec)
    const allNotes = [...(res.notes || []), ...notes.filter((n) => !(res.notes || []).includes(n))]
    if (glOK) houseRules(next, allNotes)
    const short = text.length > 70 ? text.slice(0, 68) + '…' : text
    setStatus(`${next.name}: ${next.parts.length} parts.`)
    commit(next, allNotes, mode === 'new' ? `Forged “${short}”` : `Changed: “${short}”`)
    if (mode === 'new') frame(true)
    return true
  } catch (e) {
    setStatus(e.name === 'AbortError' ? 'Stopped.' : e.message, e.name !== 'AbortError')
    return false
  } finally { busy(false); renderAuth() }
}

async function photograph() {
  const s = step()
  if (!glOK || !s) return
  ctl = new AbortController(); busy(true, 'Photographing… this takes about half a minute.')
  try {
    await artReady()
    const res = await signedPostJson('/api/forge/photo', { image: captureRender() }, ctl.signal)
    s.photo = { image: res.image, by: `${res.provider} · ${res.model}` }
    setStatus('Photo ready.')
    if (step() === s) showView('photo')
    renderHistory()
  } catch (e) {
    setStatus(e.name === 'AbortError' ? 'Stopped.' : e.message, e.name !== 'AbortError')
  } finally { busy(false); renderAuth(); renderPhoto() }
}

function busy(on, text) {
  for (const id of ['forgeBtn', 'refineBtn', 'photoBtn']) { const b = $(id); if (b) b.disabled = on }
  $('stopBtn').hidden = !on
  const st = $('stage'), b = st.querySelector('.busy')
  if (on && !b) st.insertAdjacentHTML('beforeend', '<span class="busy">working…</span>')
  if (!on && b) b.remove()
  if (on && text) setStatus(text)
}

// ---------------------------------------------------------------------------------------------------- UI
function tierOf(s) {
  if (s <= 1) return { name: 'Benign', color: '#8fb07a', ink: 'var(--moss)' }
  if (s <= 4) return { name: 'Mischievous', color: '#e0a83e', ink: 'var(--spark)' }
  if (s <= 7) return { name: 'Unsettling', color: '#d9733b', ink: 'var(--rust)' }
  return { name: 'Terrifying', color: '#c9302c', ink: 'var(--rust)' }
}
async function sha256(text) {
  try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('') } catch { return null }
}
let configText = ''
async function renderConfig() {
  configText = JSON.stringify({ style: FORGE_STYLE, sha256: await sha256(JSON.stringify(spec())), spec: spec() }, null, 2)
  $('config').textContent = configText
}
function renderSwatches() {
  const sw = (el, list, key) => {
    el.replaceChildren()
    for (const [h, n] of list) {
      const b = document.createElement('button'); b.type = 'button'; b.style.background = h; b.setAttribute('aria-label', n)
      b.setAttribute('aria-pressed', String(!!spec() && spec().palette[key] === h))
      b.addEventListener('click', () => {
        if (!spec() || spec().palette[key] === h) return
        const next = draft(); next.palette[key] = h
        commit(next, step().house, `${key === 'enamel' ? 'Enamel' : 'Glow'}: ${n}`)
      })
      el.appendChild(b)
    }
  }
  sw($('enamels'), ENAMELS, 'enamel'); sw($('glows'), GLOWS, 'glow')
}
function renderAuth() {
  const a = signedInAddress()
  $('who').innerHTML = a
    ? `Signed in as <code>${esc(a.slice(0, 6))}…${esc(a.slice(-4))}</code> · <button type="button" class="linkish" id="signOut">Sign out</button>`
    : 'Forging and photos are signed with your wallet, so each request is yours. <button type="button" class="linkish" id="signInBtn">Sign in</button>'
  $('signOut')?.addEventListener('click', () => { signOut(); renderAuth() })
  $('signInBtn')?.addEventListener('click', () => signIn().then(renderAuth, (e) => setStatus(e.message, true)))
}
function renderPhoto() {
  const p = step()?.photo
  $('photoImg').src = p ? p.image : ''
  $('photoImg').alt = p ? `Studio photograph of ${spec()?.name || 'the gremlin'}` : ''
  $('photoBy').textContent = p ? `Photographed by ${p.by}` : ''
  $('photoTab').disabled = !p
  const dl = $('photoDl'); dl.hidden = !p
  if (p) { dl.href = p.image; dl.download = (spec()?.name || 'gremlin').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png' }
  if (!p) showView('render')
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString()
}
function renderHistory() {
  const ol = $('history'); ol.replaceChildren()
  // the current step's line back to the start reads as "on this branch"; the rest are dimmed
  const line = new Set(); for (let i = state.cur; i >= 0; i = state.steps[i].parent) line.add(i)
  for (let i = state.steps.length - 1; i >= 0; i--) {
    const s = state.steps[i], li = document.createElement('li'), b = document.createElement('button')
    b.type = 'button'
    if (i === state.cur) b.setAttribute('aria-current', 'step')
    if (!line.has(i)) b.classList.add('off')
    const th = document.createElement('span'); th.className = 'thumb'; if (s.thumb) th.style.backgroundImage = `url("${s.thumb}")`
    const tx = document.createElement('span')
    const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = `${i + 1}. ${s.label}`
    const meta = document.createElement('span'); meta.className = 'meta'
    meta.textContent = [ago(s.t), s.parent >= 0 && s.parent !== i - 1 ? `from step ${s.parent + 1}` : '', s.photo ? 'photo' : ''].filter(Boolean).join(' · ')
    tx.append(lbl, document.createElement('br'), meta); b.append(th, tx)
    b.addEventListener('click', () => go(i))
    li.appendChild(b); ol.appendChild(li)
  }
  $('undoBtn').disabled = !step() || step().parent < 0
  $('redoBtn').disabled = redoTarget() < 0
}

const WEAR_LABEL = { rust: 'Rust', grime: 'Grime', soot: 'Soot', scratches: 'Scratches', patina: 'Patina', chipped: 'Chipped paint', oil: 'Oil' }
const FINISH_LABEL = { paint: 'Paint', ink: 'Tattoo ink', sticker: 'Sticker', etched: 'Etched', glow: 'Neon glow' }
function renderSurfaces() {
  const sp = spec(); if (!sp) return
  const wear = sp.wear || []
  const chips = $('wearChips'); chips.replaceChildren()
  for (const k of FORGE_WEAR) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = WEAR_LABEL[k]
    b.setAttribute('aria-pressed', String(wear.some((w) => w.kind === k)))
    b.addEventListener('click', () => {
      const next = draft(), has = (next.wear || []).some((w) => w.kind === k)
      if (has) next.wear = next.wear.filter((w) => w.kind !== k)
      else {
        if ((next.wear || []).length >= 4) return setStatus('Four kinds of weathering at most. Turn one off first.', true)
        next.wear = [...(next.wear || []), { kind: k, amount: Number($('wearAmount').value) }]
      }
      if (!next.wear.length) delete next.wear
      const { spec: checked } = checkForgeSpec(next)
      commit(checked, step().house, has ? `Removed ${WEAR_LABEL[k].toLowerCase()}` : `Added ${WEAR_LABEL[k].toLowerCase()}`)
    })
    chips.appendChild(b)
  }
  const amt = wear.length ? wear.reduce((a, w) => a + w.amount, 0) / wear.length : Number($('wearAmount').value)
  if (document.activeElement !== $('wearAmount')) $('wearAmount').value = String(amt)
  $('wearAmountOut').textContent = Math.round(Number($('wearAmount').value) * 100) + '%'
  $('wearAmount').disabled = !wear.length

  const pics = $('pics'); pics.replaceChildren()
  const offer = (key, label, src, p) => {
    const b = document.createElement('button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', `Place ${label}`)
    b.style.backgroundImage = `url("${src}")`
    b.setAttribute('aria-pressed', String(!!placing && (placing.image === p.image && placing.art === p.art) && placing.move == null))
    b.addEventListener('click', () => (placing && placing.image === p.image && placing.art === p.art ? (placing = null, setStatus(''), renderSurfaces()) : startPlacing(p)))
    pics.appendChild(b)
  }
  for (const [id, u] of Object.entries(state.uploads)) offer(id, u.label, u.data, { image: 'upload:' + id })
  for (const [id, svg] of Object.entries(sp.art || {})) offer(id, id, svgUrl(svg), { art: id })
  $('placeCancel').hidden = !placing
  $('stage').classList.toggle('placing', !!placing)

  const ul = $('decals'); ul.replaceChildren()
  const decals = sp.decals || []
  $('decalsTitle').textContent = decals.length ? `Decals (${decals.length})` : 'Decals: none yet'
  decals.forEach((d, i) => {
    const li = document.createElement('li')
    const name = d.art || state.uploads[d.image?.slice(7)]?.label || 'missing picture'
    const src = d.art ? svgUrl(sp.art[d.art]) : state.uploads[d.image?.slice(7)]?.data
    const th = document.createElement('span'); th.className = 'thumb'; if (src) th.style.backgroundImage = `url("${src}")`
    const head = document.createElement('div'); head.className = 'row'; head.style.justifyContent = 'space-between'
    const nm = document.createElement('b'); nm.textContent = name + (d.mirror ? ' ×2' : '')
    const acts = document.createElement('span'); acts.className = 'row'
    const mv = document.createElement('button'); mv.type = 'button'; mv.className = 'linkish'; mv.textContent = 'Move'
    mv.addEventListener('click', () => startPlacing({ move: i }))
    const mirror = document.createElement('button'); mirror.type = 'button'; mirror.className = 'linkish'; mirror.textContent = d.mirror ? 'One side' : 'Both sides'
    mirror.addEventListener('click', () => editDecal(i, (x) => { if (x.mirror) delete x.mirror; else x.mirror = 'x' }, d.mirror ? 'Decal on one side' : 'Decal on both sides'))
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'linkish'; rm.textContent = 'Remove'
    rm.addEventListener('click', () => {
      const next = draft(); next.decals.splice(i, 1)
      if (!next.decals.length) delete next.decals
      commit(checkForgeSpec(next).spec, step().house, `Removed “${name}”`)
    })
    acts.append(mv, mirror, rm); head.append(nm, acts)
    const sel = document.createElement('select'); sel.setAttribute('aria-label', `Finish for ${name}`)
    for (const f of FORGE_DECAL_FINISHES) { const o = document.createElement('option'); o.value = f; o.textContent = FINISH_LABEL[f]; o.selected = d.finish === f; sel.appendChild(o) }
    sel.addEventListener('change', () => editDecal(i, (x) => { x.finish = sel.value }, `${name}: ${FINISH_LABEL[sel.value].toLowerCase()}`))
    const ctrls = document.createElement('div'); ctrls.className = 'ctrls'
    const slider = (label, key, min, max, stepv) => {
      const l = document.createElement('label'); l.textContent = label
      const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = stepv; r.value = String(d[key]); r.setAttribute('aria-label', `${label} of ${name}`)
      r.addEventListener('input', () => preview((x) => { x.decals[i][key] = Number(r.value) }))
      r.addEventListener('change', () => editDecal(i, (x) => { x[key] = Number(r.value) }, `${name}: ${label.toLowerCase()}`))
      ctrls.append(l, r)
    }
    slider('Size', 'size', 0.04, 1.6, 0.01); slider('Turn', 'rot', -180, 180, 1)
    const fl = document.createElement('label'); fl.textContent = 'Finish'; ctrls.append(fl, sel)
    li.append(th, head, ctrls); ul.appendChild(li)
  })
}
const svgUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg || '')
function editDecal(i, fn, label) {
  const next = draft(); fn(next.decals[i])
  commit(checkForgeSpec(next).spec, step().house, label)
}
/** Shows an edit live (while a slider moves) without recording a step; the slider's change event commits it. */
let previewBase = null
function preview(fn) {
  const s = step(); if (!s) return
  if (!previewBase || previewBase.step !== s) previewBase = { step: s, spec: s.spec }
  const next = structuredClone(previewBase.spec); fn(next)
  s.spec = next; rebuild(false); s.spec = previewBase.spec
}
function showView(v) {
  $('stage').dataset.view = v
  $('renderTab').setAttribute('aria-pressed', String(v === 'render'))
  $('photoTab').setAttribute('aria-pressed', String(v === 'photo'))
}
function render(fresh) {
  const sp = spec(); if (!sp) return
  previewBase = null
  rebuild(fresh)
  if (document.activeElement !== $('name')) $('name').value = sp.name
  $('tagline').textContent = sp.tagline || ''
  const kinds = {}; sp.parts.forEach((p) => { kinds[p.kind] = (kinds[p.kind] || 0) + 1 })
  const extra = [
    sp.wear?.length ? `${sp.wear.length} weathering` : '', sp.decals?.length ? `${sp.decals.length} decal${sp.decals.length > 1 ? 's' : ''}` : '',
    lastSurface.missed ? `${lastSurface.missed} decal${lastSurface.missed > 1 ? 's' : ''} missed the body` : '',
    lastSurface.missingPictures ? `${lastSurface.missingPictures} picture${lastSurface.missingPictures > 1 ? 's aren’t' : ' isn’t'} in this browser` : '',
  ].filter(Boolean)
  $('code').textContent = `${sp.parts.length} parts · ` + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(' · ') + (extra.length ? ' · ' + extra.join(' · ') : '')
  const t = tierOf(sp.menace)
  $('menace').innerHTML = `Menace ${sp.menace}/10 · <span style="color:${t.ink}; font-weight:600">${t.name}</span>`
  $('meter').innerHTML = Array.from({ length: 10 }, (_, i) => `<i style="background:${i < sp.menace ? t.color : 'var(--line)'}"></i>`).join('')
  const house = step().house || []
  $('houseBody').innerHTML = house.length ? '<ul>' + house.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>' : '<p class="small muted">Passed every house rule unchanged.</p>'
  renderSwatches(); renderConfig(); renderPhoto(); renderHistory(); renderSurfaces(); save(); thumbLater()
}

// ---------------------------------------------------------------------------------------------------- wiring
function wire() {
  for (const idea of IDEAS) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = idea
    b.addEventListener('click', () => { $('prompt').value = idea; $('prompt').focus() })
    $('chips').appendChild(b)
  }
  for (const ex of Object.values(FORGE_EXAMPLES)) {
    const b = document.createElement('button'); b.type = 'button'
    b.innerHTML = `<b>${esc(ex.name)}</b><span>menace ${ex.menace}/10</span>`
    b.addEventListener('click', () => {
      const { spec: next, notes } = checkForgeSpec(structuredClone(ex))
      commit(next, notes, `Example: ${ex.name}`); frame(true); setStatus('')
    })
    $('starts').appendChild(b)
  }
  $('askForm').addEventListener('submit', (e) => {
    e.preventDefault(); const t = $('prompt').value.trim()
    if (!t) return setStatus('Describe your gremlin first, or pick an idea.', true)
    generate('new', t)
  })
  $('refineForm').addEventListener('submit', (e) => {
    e.preventDefault(); const t = $('refine').value.trim()
    if (!t) return setStatus('Say what to change first.', true)
    generate('refine', t).then((ok) => { if (ok) $('refine').value = '' })
  })
  $('photoBtn').addEventListener('click', photograph)
  $('stopBtn').addEventListener('click', () => ctl && ctl.abort())
  $('undoBtn').addEventListener('click', undo)
  $('redoBtn').addEventListener('click', redo)
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    const t = e.target, typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    if (typing) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo() }
  })
  $('name').addEventListener('input', (e) => { if (!spec()) return; spec().name = e.target.value.slice(0, 40); renderConfig(); renderHistory(); save() })
  $('picFile').addEventListener('change', (e) => { addUpload(e.target.files?.[0]); e.target.value = '' })
  $('placeCancel').addEventListener('click', () => { placing = null; setStatus(''); renderSurfaces() })
  $('wearAmount').addEventListener('input', () => {
    $('wearAmountOut').textContent = Math.round(Number($('wearAmount').value) * 100) + '%'
    preview((x) => { for (const w of x.wear || []) w.amount = Number($('wearAmount').value) })
  })
  $('wearAmount').addEventListener('change', () => {
    const next = draft(); if (!next.wear?.length) return
    for (const w of next.wear) w.amount = Number($('wearAmount').value)
    commit(next, step().house, `Weathering at ${Math.round(Number($('wearAmount').value) * 100)}%`)
  })
  const spinLabel = () => { $('spinBtn').setAttribute('aria-pressed', String(spin)); $('spinBtn').textContent = spin ? 'Stop spinning' : 'Spin' }
  spinLabel()
  $('spinBtn').addEventListener('click', () => { spin = !spin; spinLabel() })
  $('viewBtn').addEventListener('click', () => { if (robot) robot.rotation.y = 0; frame(true) })
  $('renderTab').addEventListener('click', () => showView('render'))
  $('photoTab').addEventListener('click', () => showView('photo'))
  $('copyBtn').addEventListener('click', () => {
    const done = (t) => { $('copyStatus').textContent = t; setTimeout(() => { $('copyStatus').textContent = '' }, 2500) }
    navigator.clipboard.writeText(configText).then(() => done('Copied.'), () => done('Copy failed: open “Design spec” and copy it by hand.'))
  })
}

async function loadCaps() {
  try { caps = await (await fetch('/api/forge')).json() } catch { caps = { design: false, photo: null } }
  $('askForm').hidden = !caps.design
  $('refineForm').hidden = !caps.design
  $('photoBtn').hidden = !caps.photo || !glOK
  $('offline').hidden = !!caps.design
}

document.getElementById('logo').innerHTML = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })
initStudio()
wire()
if (!step()) { const r = checkForgeSpec(structuredClone(FORGE_EXAMPLES.octopod)); state.steps = [{ spec: r.spec, house: r.notes, label: 'Example: Octopod', parent: -1, t: Date.now() }]; state.cur = 0 }
render(true)
renderAuth()
loadCaps()
