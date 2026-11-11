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
import { FORGE_CRITIQUE_MAX_STILLS, FORGE_DECAL_FINISHES, FORGE_EXAMPLES, FORGE_MATERIALS, FORGE_STYLE, FORGE_WEAR, checkForgeSpec, curlPoints } from '@gremlins/hatch'
import { fitName, hideCursor, mountHud, renderHud, tickHud } from './forge-hud.js'
import { applySkins, applyPose, drawLabels, forgetIsolate, mountLabels, resetView, startTour, step as stepView, stopTour, toggleExplode, toggleIsolate, toggleMode, view } from './forge-motion.js'
import { addDecals, artReady, wearFor, wearFrame, wearMaterial } from './forge-surfaces.js'
import { creatureSvg } from '@gremlins/hatch/creature'
import { account, hasSessionKey, mountAuth, onAccountChange, sessionPostJson, signIn, signOut, walletErrorMessage } from './auth.ts'

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
function commit(nextSpec, house, label, opts = {}) {
  const last = step()
  // Repeated nudges of the same kind fold into one step instead of flooding the history.
  if (opts.coalesce && last && last.label === label && state.cur === state.steps.length - 1 && Date.now() - last.t < 4000) {
    last.spec = nextSpec; last.t = Date.now(); last.thumb = undefined; last.photo = undefined
    render(false); return
  }
  if (!opts.keepSelection) selected = new Set()
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
  state.cur = i; placing = null; selected = new Set()
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
let selected = new Set() // indices into spec().parts picked in the 3D view
let lastSurface = { missed: 0, missingPictures: 0 }

// ---------------------------------------------------------------------------------------------------- studio
const STUDIO = '#e6e1d7' // pale studio: reads in a feed, and the accent stands out on it
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
  scene.background = new T.Color(STUDIO)
  scene.environment = new T.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
  camera = new T.PerspectiveCamera(26, 1, 0.1, 80)
  controls = new OrbitControls(camera, renderer.domElement)
  Object.assign(controls, { enableDamping: true, enablePan: false, minDistance: 3, maxDistance: 14, maxPolarAngle: 1.5, minPolarAngle: 0.3 })
  // The backdrop and lights orbit with the camera, like a photographer walking round with the studio, so the paper
  // sweep is always behind the robot and never between it and the camera.
  rig = new T.Group(); scene.add(rig)
  const sweep = new T.Mesh(sweepGeometry(), new T.MeshStandardMaterial({ color: STUDIO, roughness: 0.95 }))
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
    if (!down) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 500
    down = null
    if (moved >= 6 || !quick) return // that was an orbit drag
    if (placing) placeAt(e)
    else selectAt(e)
  })
  // Left alone for 25 s the console tours itself; any click, key or scroll outside the timeline hands control back.
  let lastActive = performance.now() / 1000
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, (e) => {
    lastActive = performance.now() / 1000
    if (view.tour && !e.target.closest?.('#dTour')) { stopTour(); hideCursor(); syncConsole(true) }
  }, { capture: true, passive: true })
  mountLabels(stage)
  mountHud({ operator: () => account()?.address })
  let lastT = 0, avg = 1 / 60, slow = 0
  renderer.setAnimationLoop(() => {
    if (document.hidden) return
    const now = performance.now() / 1000, dt = lastT ? Math.min(0.1, now - lastT) : 0; lastT = now
    // Quality step for integrated GPUs: drop to 1x pixels after ~2 s of frames slower than 32 fps.
    avg = avg * 0.95 + dt * 0.05
    if (avg > 1 / 32 && ++slow > 120 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); slow = 0 }
    if (spin && robot && !placing && !selected.size) robot.rotation.y += 0.004
    if (inner && spec()) {
      const still = !!placing || selected.size > 0, rig = inner.userData.rig
      applyPose(rig, spec(), stepView(spec(), dt, now, still, reduceMotion))
      applySkins(rig, still ? null : view.isolate, !still && view.xray)
      focusCamera(dt)
      syncConsole()
      tickHud(now)
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
      if (!view.tour && view.beats.length > 1 && !reduceMotion && !still && !ctl && !typing && now - lastActive > 25) { startTour(now); syncConsole(true) }
    }
    controls.update()
    rig.rotation.y = controls.getAzimuthalAngle()
    if (robot) { robot.updateMatrixWorld(); wearFrame.value.copy(robot.matrixWorld).invert() }
    renderer.render(scene, camera)
    if (inner) drawLabels(inner.userData.rig, camera, renderer.domElement.clientWidth, renderer.domElement.clientHeight)
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
  hero = { target: controls.target.clone(), dist }
  focusId = `${view.isolate || ''}|${view.explodeTo > 0}`; camAnim = null
}
// Isolating an assembly glides the camera in on it; clearing glides back to the hero framing. Orbiting stays free.
let hero = null, focusId = null, camAnim = null
function focusCamera(dt) {
  const id = view.isolate, want = `${id || ''}|${view.explodeTo > 0}`
  if (want !== focusId && hero) {
    focusId = want
    const r = id && inner.userData.rig[id]
    const toT = r?.anchor ? r.anchor.getWorldPosition(new T.Vector3()) : hero.target.clone()
    // isolate moves in on the part; the exploded view steps back so the flown-out assemblies stay in frame
    const toD = hero.dist * (r ? 0.72 : 1) * (view.explodeTo > 0 ? 1.4 : 1)
    camAnim = { t: 0, fromT: controls.target.clone(), toT, fromD: camera.position.distanceTo(controls.target), toD }
  }
  if (!camAnim) return
  camAnim.t = reduceMotion ? 1 : Math.min(1, camAnim.t + dt / 0.9)
  const k = camAnim.t < 0.5 ? 4 * camAnim.t ** 3 : 1 - (-2 * camAnim.t + 2) ** 3 / 2
  const dir = new T.Vector3().subVectors(camera.position, controls.target).normalize()
  controls.target.lerpVectors(camAnim.fromT, camAnim.toT, k)
  camera.position.copy(controls.target).addScaledVector(dir, camAnim.fromD + (camAnim.toD - camAnim.fromD) * k)
  if (camAnim.t >= 1) camAnim = null
}

// ---------------------------------------------------------------------------------------------------- materials + geometry
function materials(pal) {
  return {
    enamel: new T.MeshPhysicalMaterial({ color: pal.enamel, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 }),
    accent: new T.MeshPhysicalMaterial({ color: pal.accent, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 }),
    chrome: new T.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.14, envMapIntensity: 1.6 }),
    brass: new T.MeshStandardMaterial({ color: '#e0ad55', metalness: 1, roughness: 0.2, envMapIntensity: 1.6 }),
    copper: new T.MeshStandardMaterial({ color: '#d0805a', metalness: 1, roughness: 0.24, envMapIntensity: 1.5 }),
    glass: new T.MeshPhysicalMaterial({ color: '#0b1016', roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02 }),
    glow: new T.MeshBasicMaterial({ color: pal.glow, toneMapped: false }),
    rubber: new T.MeshStandardMaterial({ color: '#1e1f21', roughness: 0.85 }),
    steel: new T.MeshStandardMaterial({ color: '#3a3f45', metalness: 0.85, roughness: 0.48 }),
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
/** The widest radius a lathe profile reaches at height `y`, or null when `y` is off the part. */
function latheRadiusAt(pts, y) {
  let r = null
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    if ((y - a.y) * (y - b.y) > 0 || a.y === b.y) continue
    const x = a.x + (b.x - a.x) * ((y - a.y) / (b.y - a.y))
    if (r == null || x > r) r = x
  }
  return r
}
/** Rivet rows (one instanced draw each) and dark panel seams round a lathe or cylinder. */
function addDetail(g, p, M, radiusAt) {
  for (const y of p.seams || []) {
    const r = radiusAt(y); if (!r || r < 0.03) continue
    const seam = mesh(new T.TorusGeometry(r + 0.002, Math.max(0.004, r * 0.012), 6, 96), M.rubber); seam.rotation.x = Math.PI / 2; seam.position.y = y; g.add(seam)
  }
  for (const row of p.rivets || []) {
    const r = radiusAt(row.y); if (!r || r < 0.03) continue
    const rr = Math.min(0.03, Math.max(0.011, r * 0.028))
    const studs = new T.InstancedMesh(new T.SphereGeometry(rr, 10, 6), M[row.mat || 'steel'], row.count), m = new T.Matrix4()
    for (let i = 0; i < row.count; i++) { const a = (i / row.count) * Math.PI * 2; studs.setMatrixAt(i, m.makeTranslation(Math.sin(a) * r, row.y, Math.cos(a) * r)) }
    studs.castShadow = studs.receiveShadow = true; studs.computeBoundingSphere(); g.add(studs)
  }
}
/** A machined drum: flat faces with a chamfered rim, unit radius and height, axis y. */
const LINK_PROFILES = {
  drum: [[0, -0.5], [0.82, -0.5], [1, -0.36], [1, 0.36], [0.82, 0.5], [0, 0.5]],
  disc: [[0, -0.5], [0.9, -0.5], [1, -0.25], [1, 0.25], [0.9, 0.5], [0, 0.5]],
}
const LINK_FILL = { drum: 0.78, disc: 0.42, ball: 0.9, block: 0.7 }
/** A chain: `count` links threaded on a dark spine along the curve, each link one instance of a single draw. */
function buildChain(g, p, M) {
  const curve = new T.CatmullRomCurve3(p.points.map((a) => new T.Vector3(a[0], a[1], a[2])))
  const [r0, r1] = Array.isArray(p.radius) ? p.radius : [p.radius, p.radius]
  const len = curve.getLength(), n = p.count, segLen = len / n
  g.add(mesh(taperedTube(curve, r0 * 0.5, r1 * 0.5, Math.max(12, Math.min(120, Math.round(len * 40)))), M.steel))
  const geo = p.link === 'ball' ? new T.SphereGeometry(1, 20, 14)
    : p.link === 'block' ? new RoundedBoxGeometry(1.6, 1, 1.6, 2, 0.2)
      : new T.LatheGeometry(LINK_PROFILES[p.link || 'drum'].map(([x, y]) => new T.Vector2(x, y)), 32)
  const links = new T.InstancedMesh(geo, M[p.mat], n)
  const pt = new T.Vector3(), tg = new T.Vector3(), up = new T.Vector3(0, 1, 0), q = new T.Quaternion(), sc = new T.Vector3(), m = new T.Matrix4()
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, r = r0 + (r1 - r0) * u
    curve.getPointAt(u, pt); curve.getTangentAt(u, tg); q.setFromUnitVectors(up, tg)
    const h = p.link === 'ball' ? Math.min(r, segLen * 0.5) : segLen * LINK_FILL[p.link || 'drum']
    if (p.link === 'ball') sc.set(h, h, h); else sc.set(r, h, r)
    links.setMatrixAt(i, m.compose(pt, q, sc))
  }
  links.castShadow = links.receiveShadow = true; links.computeBoundingSphere()
  if (M[p.mat].userData.wear) links.userData.wear = M[p.mat].userData.wear
  g.add(links)
}
function buildOne(p, M0, spec) {
  const g = new T.Group(), mat = partMats(spec, p, M0)
  const M = new Proxy(M0, { get: (o, k) => (typeof k === 'string' && k in o && k !== 'glow' && !k.startsWith('__') ? mat(k) : o[k]) })
  if (p.kind === 'lathe') {
    let pts = p.profile.map(([r, y]) => new T.Vector2(r, y))
    if (pts.length >= 3) pts = new T.SplineCurve(pts).getPoints(Math.min(120, pts.length * 12)).map((v) => new T.Vector2(Math.max(0, v.x), v.y))
    g.add(mesh(new T.LatheGeometry(pts, 96), M[p.mat]))
    addDetail(g, p, M, (y) => latheRadiusAt(pts, y))
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
  } else if (p.kind === 'chain') {
    buildChain(g, p, M)
    return g // chains are authored in world coordinates too
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
    if (p.kind === 'cylinder') addDetail(g, p, M, (y) => (Math.abs(y) <= s[2] / 2 + 1e-6 ? s[1] + (s[0] - s[1]) * (y / s[2] + 0.5) : null))
  }
  g.position.set(p.pos[0], p.pos[1], p.pos[2])
  g.rotation.set(p.rot[0] * D, p.rot[1] * D, p.rot[2] * D)
  if (p.scale) g.scale.set(p.scale[0], p.scale[1], p.scale[2])
  return g
}
/**
 * Builds a part with its mirror and array copies. Returns the copies (`plain` and, kept apart for "open" joints,
 * `mirrored`) plus `holders`: the group directly holding each copy, so a bend can swap every copy's shape at once.
 */
function expand(p, M, spec) {
  const base = buildOne(p, M, spec), plain = new T.Group(), mirrored = new T.Group(), holders = []
  const items = [{ it: base, m: false }]
  if (p.mirror === 'x') items.push({ it: base.clone(), m: true })
  const n = p.array ? p.array.count : 1
  for (let i = 0; i < n; i++) for (const { it, m } of items) {
    const g = new T.Group(), hold = m ? new T.Group() : g
    if (m) { hold.scale.x = -1; g.add(hold) }
    hold.add(i === 0 ? it : it.clone()); holders.push(hold)
    if (p.array && p.array.type === 'radial') g.rotation.y = (i / n) * Math.PI * 2
    if (p.array && p.array.type === 'linear') g.position.set(p.array.step[0] * i, p.array.step[1] * i, p.array.step[2] * i)
    ;(m ? mirrored : plain).add(g)
  }
  return { plain, mirrored, holders }
}
// Ink outline: back faces pushed out along their normals in dark ink, drawn behind the part (teardown's rule for
// near-white parts on a pale backdrop, so a cream gremlin keeps its silhouette).
const inkMat = new T.MeshBasicMaterial({ color: '#2a2622', side: T.BackSide, toneMapped: false })
inkMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * 0.009;') }
/** Which enamels are light enough to need the outline. */
function needsInk(pal) {
  const light = (hex) => { const c = new T.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.55 }
  return { enamel: light(pal.enamel), accent: light(pal.accent) }
}
const tagPart = (o, i) => o.traverse((n) => { if (n.isMesh) n.userData.part = i })
/**
 * The scene graph the motion code poses: one node per assembly (moved by explode), holding a pivot group at its joint
 * (turned, slid or scaled), holding the parts offset back so they sit where the design put them. "open" assemblies get a
 * second pivot at the mirror-image hinge for their mirrored copies. inner.userData.rig maps assembly id to all of it.
 */
function buildParts(spec, M) {
  const g = new T.Group(), rig = {}
  const asms = spec.assemblies?.length ? spec.assemblies : [{ id: 'body', name: 'Body', role: '', explode: [0, 0, 0], states: ['READY', 'ACTIVE'] }]
  for (const a of asms) {
    const node = new T.Group(); node.name = `asm:${a.id}`; g.add(node)
    const pivotGroup = (pv0) => {
      const pv = new T.Group(); pv.position.set(pv0[0], pv0[1], pv0[2])
      const content = new T.Group(); content.position.set(-pv0[0], -pv0[1], -pv0[2]); pv.add(content); node.add(pv)
      return { pv, content }
    }
    const j = a.joint, piv = j ? j.pivot : [0, 0, 0]
    rig[a.id] = {
      a, node, bends: [], bent: 0,
      main: pivotGroup(piv),
      mirror: j?.move === 'open' ? pivotGroup([-piv[0], piv[1], piv[2]]) : null,
      axis: j ? new T.Vector3(...j.axis).normalize() : new T.Vector3(0, 1, 0),
      mirrorAxis: j ? new T.Vector3(-j.axis[0], j.axis[1], j.axis[2]).normalize() : new T.Vector3(0, 1, 0),
    }
  }
  const fallback = rig.body || Object.values(rig)[0]
  const inked = needsInk(spec.palette)
  spec.parts.forEach((p, i) => {
    const r = rig[p.asm] || fallback, { plain, mirrored, holders } = expand(p, M, spec)
    tagPart(plain, i); tagPart(mirrored, i)
    // Shells (the enamel volumes) go to glass under x-ray; light ones get a thin ink outline on the pale studio.
    if (p.mat === 'enamel' || p.mat === 'accent') {
      const skin = partMats(spec, p, M)(p.mat)
      for (const o of [plain, mirrored]) o.traverse((n) => {
        if (!n.isMesh || n.material !== skin) return
        n.userData.shell = true
        if (inked[p.mat] && !n.isInstancedMesh) { const ink = new T.Mesh(n.geometry, inkMat); ink.userData.ink = ink.userData.overlay = true; n.add(ink) }
      })
    }
    r.main.content.add(plain)
    ;(r.mirror ? r.mirror.content : r.main.content).add(mirrored)
    // Curling limbs: rebuild the part along bent points and swap it into every copy.
    if (r.a.joint?.move === 'curl' && pathed(p)) {
      r.bends.push((deg) => {
        const bent = buildOne({ ...p, points: curlPoints(p.points, r.a.joint.axis, deg) }, M, spec)
        tagPart(bent, i)
        holders.forEach((h, k) => {
          for (const old of [...h.children]) { h.remove(old); if (k === 0) old.traverse((n) => n.geometry?.dispose()) }
          h.add(k === 0 ? bent : bent.clone())
        })
      })
    }
  })
  // A label anchor at each assembly's centre, inside its node so it follows the explode.
  g.updateMatrixWorld(true)
  for (const r of Object.values(rig)) {
    const bb = new T.Box3().setFromObject(r.node)
    if (bb.isEmpty()) continue
    r.anchor = new T.Object3D(); bb.getCenter(r.anchor.position); r.node.add(r.anchor)
  }
  g.userData.rig = rig
  return g
}
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
  forgetIsolate(); resetView(sp)
  const bb = new T.Box3().setFromObject(inner), size = new T.Vector3(), c = new T.Vector3(); bb.getSize(size); bb.getCenter(c)
  let s = Math.min(2.2, Math.max(0.4, 2.4 / Math.max(0.3, size.y)))
  if (size.x * s > 3.4) s = 3.4 / size.x
  const holder = new T.Group(); holder.scale.setScalar(s); holder.position.set(-c.x * s, -bb.min.y * s, -c.z * s); holder.add(inner)
  robot = new T.Group(); robot.add(holder)
  const glows = []; robot.updateMatrixWorld(true)
  lastSurface = addDecals(sp, inner, robot, state.uploads, s)
  applySelection()
  robot.rotation.y = rot
  inner.traverse((n) => { if (n.userData.glow) glows.push(new T.Vector3().setFromMatrixPosition(n.matrixWorld)) })
  if (glows.length) {
    const avg = glows.reduce((a, b) => a.add(b), new T.Vector3()).multiplyScalar(1 / glows.length)
    const lamp = new T.PointLight(sp.palette.glow, 2.4, 1.8, 2); lamp.position.copy(avg).add(new T.Vector3(0, 0, 0.3)); robot.add(lamp)
  }
  scene.add(robot)
  renderer.compileAsync?.(scene, camera).catch(() => {}) // warm every program in parallel so the first frames don't stall
  renderConsole(sp)
  const key = JSON.stringify(sp.parts).length + ':' + sp.parts.length
  if (fresh || key !== lastShapeKey) { lastShapeKey = key; frame(fresh) }
}

// ---------------------------------------------------------------------------------------------------- console
/** Buttons for the design's assemblies and modes, rebuilt when the design changes. */
function renderConsole(sp) {
  const asms = sp.assemblies || [], modes = (sp.modes || []).filter((m) => m.id !== 'idle')
  $('hud').dataset.single = String(asms.length < 2 && !modes.length)
  $('asmChips').replaceChildren(...asms.map((a) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.asm = a.id; b.textContent = a.name; b.title = a.role || a.name
    b.addEventListener('click', () => { toggleIsolate(a.id); syncConsole(true) })
    return b
  }))
  $('modeRow').hidden = !modes.length
  $('modeChips').replaceChildren(...modes.map((m) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.mode = m.id; b.textContent = m.name
    b.addEventListener('click', () => { toggleMode(m.id); syncConsole(true) })
    return b
  }))
  renderHud(sp)
  syncConsole(true)
}
let consoleKey = ''
/** Keeps the pressed states and the big mode label in step with the viewer (cheap: only touches the DOM on change). */
function syncConsole(force) {
  const m = spec()?.modes?.find((x) => x.id === view.mode)
  const up = view.mode !== 'idle' && (view.inputTo > 0 || view.input > 0.02)
  const key = [view.isolate, up && view.mode, view.explodeTo, view.labels, view.tour, view.xray].join('|')
  if (!force && key === consoleKey) return
  consoleKey = key
  for (const b of $('asmChips').children) b.setAttribute('aria-pressed', String(view.isolate === b.dataset.asm))
  for (const b of $('modeChips').children) b.setAttribute('aria-pressed', String(up && view.mode === b.dataset.mode))
  $('dLabels').setAttribute('aria-pressed', String(view.labels))
  $('dExplode').setAttribute('aria-pressed', String(view.explodeTo > 0))
  $('dTour').setAttribute('aria-pressed', String(view.tour))
  $('dXray').setAttribute('aria-pressed', String(view.xray))
  if (!view.tour) hideCursor()
  const ml = $('modeLabel'), word = up ? m?.name : view.explodeTo > 0 ? 'Exploded' : view.isolate ? spec()?.assemblies?.find((a) => a.id === view.isolate)?.name : ''
  ml.classList.toggle('rest', !word)
  if (word) ml.lastChild.textContent = word
}
$('dLabels').addEventListener('click', () => { view.labels = !view.labels; syncConsole(true) })
$('dXray').addEventListener('click', () => { view.xray = !view.xray; syncConsole(true) })
$('dExplode').addEventListener('click', () => { toggleExplode(); syncConsole(true) })
$('dTour').addEventListener('click', () => { if (view.tour) stopTour(); else startTour(performance.now() / 1000); syncConsole(true) })

/** A square studio frame (1024×1024 PNG for the image model, small JPEGs for history) without disturbing the live view. */
function captureRender(size = 1024, type = 'image/png', pose = { idle: false }) {
  // The photo and the history thumbnails show the gremlin itself: at rest, solid, no outlines (review stills pass a
  // mode's pose instead). The next frame restores the view.
  if (inner) {
    applyPose(inner.userData.rig, spec(), pose); applySkins(inner.userData.rig, null, false)
    inner.traverse((n) => { if (n.userData.ink) n.visible = false })
    forgetIsolate()
  }
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

// ---------------------------------------------------------------------------------------------------- selecting parts
const selMat = new T.MeshBasicMaterial({ color: '#ff9d2e', transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false })
// An outline: the back faces pushed out along their normals, drawn in solid orange behind the part.
const outlineMat = new T.MeshBasicMaterial({ color: '#ff8a00', side: T.BackSide, toneMapped: false })
outlineMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * 0.016;') }
let overlays = []
/** A copy of a mesh's shape in another material; instanced meshes share their instance transforms. */
function overlayOf(n, mat) {
  if (!n.isInstancedMesh) return new T.Mesh(n.geometry, mat)
  const o = new T.InstancedMesh(n.geometry, mat, n.count); o.instanceMatrix = n.instanceMatrix; o.frustumCulled = false
  return o
}
/** Tints every mesh of the selected parts (all mirror and array copies) with an additive glow. */
function applySelection() {
  for (const o of overlays) o.parent?.remove(o)
  overlays = []
  if (!inner || !selected.size) return
  const hits = []
  inner.traverse((n) => { if (n.isMesh && !n.userData.overlay && !n.userData.decal && selected.has(n.userData.part)) hits.push(n) })
  for (const n of hits) {
    const tint = overlayOf(n, selMat), line = overlayOf(n, outlineMat)
    tint.userData.overlay = line.userData.overlay = true; tint.renderOrder = 3
    n.add(tint, line); overlays.push(tint, line)
  }
}
function pickPart(e) {
  if (!robot || !inner) return null
  const r = renderer.domElement.getBoundingClientRect()
  const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
  const targets = []; inner.traverse((n) => { if (n.isMesh && !n.userData.overlay && !n.userData.decal) targets.push(n) })
  const hit = ray.intersectObjects(targets, false)[0]
  return hit ? hit.object.userData.part : null
}
function selectAt(e) {
  const i = pickPart(e)
  if (i == null) { if (!e.shiftKey) setSelection([]); return }
  if (e.shiftKey) { const n = new Set(selected); n.has(i) ? n.delete(i) : n.add(i); setSelection([...n]) }
  else setSelection(selected.size === 1 && selected.has(i) ? [] : [i])
}
function setSelection(list) {
  const n = spec()?.parts.length ?? 0
  selected = new Set(list.filter((i) => i >= 0 && i < n))
  applySelection(); renderInspector()
}

const KIND_LABEL = { lathe: 'Body', tube: 'Tube', chain: 'Chain', extrude: 'Plate', visor: 'Visor', eye: 'Eye', sphere: 'Sphere', box: 'Box', cylinder: 'Cylinder', cone: 'Cone', torus: 'Ring', capsule: 'Capsule' }
function partLabel(p) {
  const copies = (p.mirror ? 2 : 1) * (p.array ? p.array.count : 1)
  const what = p.kind === 'eye' ? `Eye (${p.eye})` : p.kind === 'visor' ? 'Visor' : `${KIND_LABEL[p.kind]} · ${p.mat}`
  return what + (copies > 1 ? ` ×${copies}` : '')
}
const r3 = (x) => Math.round(x * 1000) / 1000
/** Tubes and chains are authored as world-space points rather than a position and rotation. */
const pathed = (p) => p.kind === 'tube' || p.kind === 'chain'
const anchor = (p) => (pathed(p) ? p.points.reduce((a, q) => [a[0] + q[0] / p.points.length, a[1] + q[1] / p.points.length, a[2] + q[2] / p.points.length], [0, 0, 0]) : p.pos)
function selectionCentre(parts) {
  const list = [...selected].map((i) => anchor(parts[i]))
  return list.reduce((a, v) => [a[0] + v[0] / list.length, a[1] + v[1] / list.length, a[2] + v[2] / list.length], [0, 0, 0])
}
function movePart(p, d) {
  if (pathed(p)) p.points = p.points.map((q) => [r3(q[0] + d[0]), r3(q[1] + d[1]), r3(q[2] + d[2])])
  else p.pos = [r3(p.pos[0] + d[0]), r3(p.pos[1] + d[1]), r3(p.pos[2] + d[2])]
}
/** Turns a part about the vertical axis through `c`, as a true world-space turn (its own rotation composed, not added). */
function turnPart(p, deg, c) {
  const a = deg * D, cos = Math.cos(a), sin = Math.sin(a)
  const spin = (q) => [r3(c[0] + (q[0] - c[0]) * cos + (q[2] - c[2]) * sin), q[1], r3(c[2] - (q[0] - c[0]) * sin + (q[2] - c[2]) * cos)]
  if (pathed(p)) { p.points = p.points.map(spin); return }
  p.pos = spin(p.pos)
  const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), a).multiply(new T.Quaternion().setFromEuler(new T.Euler(p.rot[0] * D, p.rot[1] * D, p.rot[2] * D)))
  const e = new T.Euler().setFromQuaternion(q)
  p.rot = [r3(e.x / D), r3(e.y / D), r3(e.z / D)]
}
/** Scales a part about `c`: its place moves with the scale and so does its own size. */
function scalePart(p, k, c) {
  const sc = (q) => [r3(c[0] + (q[0] - c[0]) * k), r3(c[1] + (q[1] - c[1]) * k), r3(c[2] + (q[2] - c[2]) * k)]
  if (pathed(p)) {
    p.points = p.points.map(sc)
    p.radius = Array.isArray(p.radius) ? p.radius.map((r) => r3(r * k)) : r3(p.radius * k)
    return
  }
  p.pos = sc(p.pos)
  const s0 = p.scale || [1, 1, 1]
  p.scale = s0.map((v) => r3(v * k))
}
function editSelected(fn, label, opts = {}) {
  if (!selected.size) return
  const next = draft(), c = selectionCentre(next.parts)
  for (const i of selected) fn(next.parts[i], c, i)
  const { spec: checked } = checkForgeSpec(next)
  commit(checked, step().house, label, { keepSelection: true, ...opts })
}
function deleteSelected() {
  if (!selected.size) return
  const n = selected.size, next = draft()
  if (n >= next.parts.length) return setStatus('A gremlin needs at least one part. Leave something selected out.', true)
  next.parts = next.parts.filter((_, i) => !selected.has(i))
  commit(checkForgeSpec(next).spec, step().house, `Deleted ${n} part${n > 1 ? 's' : ''}`)
}
function duplicateSelected() {
  if (!selected.size) return
  const next = draft(), start = next.parts.length
  const copies = [...selected].map((i) => { const p = structuredClone(next.parts[i]); delete p.house; movePart(p, [0.2, 0, 0]); return p })
  next.parts.push(...copies)
  const { spec: checked } = checkForgeSpec(next)
  commit(checked, step().house, `Duplicated ${copies.length} part${copies.length > 1 ? 's' : ''}`)
  setSelection(copies.map((_, k) => start + k).filter((i) => i < checked.parts.length))
}

let panelBeforeSelection = null
function renderInspector() {
  const sp = spec(), box = $('panelSelection')
  $('selectHint').hidden = !!selected.size
  const was = !box.hidden
  box.hidden = !sp || !selected.size
  if (box.hidden) {
    // back to whichever panel was open before the selection took over
    if (was) { box.open = false; const back = panelBeforeSelection && $(panelBeforeSelection); if (back) back.open = true; sizePanels() }
    return
  }
  if (!was) { panelBeforeSelection = document.querySelector('#panels > details[open]:not(#panelSelection)')?.id || null; box.open = true; sizePanels() }
  const parts = [...selected].map((i) => sp.parts[i])
  $('selTitle').textContent = `${parts.length} part${parts.length > 1 ? 's' : ''} selected`
  $('badgeSelection').textContent = `${parts.length} selected`
  const list = $('selList'); list.replaceChildren()
  for (const i of selected) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = partLabel(sp.parts[i]); b.title = 'Remove from the selection'
    b.addEventListener('click', () => setSelection([...selected].filter((j) => j !== i)))
    list.appendChild(b)
  }
  // material
  const withMat = parts.filter((p) => p.mat), sel = $('selMat'); sel.replaceChildren()
  const mats = new Set(withMat.map((p) => p.mat))
  if (mats.size !== 1) { const o = document.createElement('option'); o.value = ''; o.textContent = withMat.length ? 'Mixed' : 'Fixed (visor or eye)'; sel.appendChild(o) }
  for (const m of FORGE_MATERIALS) { const o = document.createElement('option'); o.value = m; o.textContent = m; o.selected = mats.size === 1 && mats.has(m); sel.appendChild(o) }
  sel.disabled = !withMat.length
  // nudges
  const nudge = (el, items) => {
    el.replaceChildren()
    for (const [text, title, fn, label] of items) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title)
      b.addEventListener('click', () => editSelected(fn, label, { coalesce: true }))
      el.appendChild(b)
    }
  }
  const S = 0.05
  nudge($('selMove'), [
    ['←', 'Move left', (p) => movePart(p, [-S, 0, 0]), 'Moved parts'], ['→', 'Move right', (p) => movePart(p, [S, 0, 0]), 'Moved parts'],
    ['↑', 'Move up', (p) => movePart(p, [0, S, 0]), 'Moved parts'], ['↓', 'Move down', (p) => movePart(p, [0, -S, 0]), 'Moved parts'],
    ['Fwd', 'Move toward the front', (p) => movePart(p, [0, 0, S]), 'Moved parts'], ['Back', 'Move toward the back', (p) => movePart(p, [0, 0, -S]), 'Moved parts'],
  ])
  nudge($('selShape'), [
    ['⟲ 15°', 'Turn left 15 degrees', (p, c) => turnPart(p, 15, c), 'Turned parts'], ['⟳ 15°', 'Turn right 15 degrees', (p, c) => turnPart(p, -15, c), 'Turned parts'],
    ['− 10%', 'Make smaller', (p, c) => scalePart(p, 1 / 1.1, c), 'Resized parts'], ['+ 10%', 'Make bigger', (p, c) => scalePart(p, 1.1, c), 'Resized parts'],
  ])
  // exact numbers for a single part
  const ex = $('selExact'); ex.replaceChildren()
  if (parts.length === 1) {
    const p = parts[0], i = [...selected][0]
    const row = (label, values, apply, opts = {}) => {
      const l = document.createElement('span'); l.textContent = label
      const w = document.createElement('span'); w.className = 'xyz'
      values.forEach((v, k) => {
        const inp = document.createElement('input'); inp.type = 'number'; inp.step = opts.step || '0.01'; inp.value = String(r3(v)); inp.setAttribute('aria-label', `${label} ${opts.names ? opts.names[k] : 'xyz'[k]}`)
        inp.addEventListener('change', () => { const n = Number(inp.value); if (Number.isFinite(n)) editSelected((q) => apply(q, k, n), `${label} of ${partLabel(p)}`) })
        w.appendChild(inp)
      })
      ex.append(l, w)
    }
    if (!pathed(p)) {
      row('Position', p.pos, (q, k, n) => { q.pos[k] = n })
      row('Rotation°', p.rot, (q, k, n) => { q.rot[k] = n }, { step: '5' })
      row('Stretch', p.scale || [1, 1, 1], (q, k, n) => { q.scale = q.scale || [1, 1, 1]; q.scale[k] = n }, { step: '0.05' })
    }
    if (pathed(p)) row('Radius', Array.isArray(p.radius) ? p.radius : [p.radius], (q, k, n) => { if (Array.isArray(q.radius)) q.radius[k] = n; else q.radius = n }, { names: ['start', 'end'], step: '0.005' })
    const names = { sphere: ['radius'], box: ['width', 'height', 'depth'], cylinder: ['top', 'bottom', 'height'], cone: ['radius', 'height'], torus: ['ring', 'tube'], capsule: ['radius', 'length'], eye: ['size'] }[p.kind]
    if (names) row('Size', p.size, (q, k, n) => { q.size[k] = n }, { names, step: '0.01' })
    if (p.kind === 'visor') row('Size', [p.w, p.h], (q, k, n) => { q[k ? 'h' : 'w'] = n }, { names: ['width', 'height'] })
    void i
  }
  // wear on just these parts
  const wear = $('selWear'); wear.replaceChildren()
  const canWear = parts.filter((p) => p.kind !== 'eye')
  for (const k of FORGE_WEAR) {
    const all = canWear.length && canWear.every((p) => (p.wear || []).some((w) => w.kind === k))
    const b = document.createElement('button'); b.type = 'button'; b.textContent = WEAR_LABEL[k]; b.setAttribute('aria-pressed', String(!!all))
    b.disabled = !canWear.length
    b.addEventListener('click', () => editSelected((p) => {
      if (p.kind === 'eye') return
      if (all) { p.wear = (p.wear || []).filter((w) => w.kind !== k); if (!p.wear.length) delete p.wear }
      else if (!(p.wear || []).some((w) => w.kind === k) && (p.wear || []).length < 3) p.wear = [...(p.wear || []), { kind: k, amount: 0.4 }]
    }, `${all ? 'Removed' : 'Added'} ${WEAR_LABEL[k].toLowerCase()} on ${parts.length} part${parts.length > 1 ? 's' : ''}`))
    wear.appendChild(b)
  }
  const mirrored = parts.every((p) => p.mirror)
  $('selMirror').textContent = mirrored ? 'Stop mirroring' : 'Mirror to the other side'
}

// ---------------------------------------------------------------------------------------------------- placing decals
function placeAt(e) {
  if (!robot || !inner) return
  const r = renderer.domElement.getBoundingClientRect()
  const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
  const targets = []; inner.traverse((n) => { if (n.isMesh && !n.userData.glow && !n.userData.overlay && !n.userData.decal) targets.push(n) })
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
  if (!caps.design) {
    setStatus('Requests need Claude, which isn’t switched on on this server yet (start the board with ANTHROPIC_API_KEY). Everything else on this page still works.', true)
    return false
  }
  ctl = new AbortController(); busy(true, mode === 'new' ? 'Designing… this takes a minute or two.' : 'Reworking the design…')
  try {
    const body = { mode, text, care: $('care').checked }
    if (mode === 'refine') body.spec = spec()
    const ups = Object.entries(state.uploads).slice(0, 6).map(([id, u]) => ({ id, label: u.label }))
    if (ups.length) body.uploads = ups
    if (reference) body.reference = reference.data
    const res = await sessionPostJson('/api/forge/design', body, { scope: 'forge', signal: ctl.signal })
    const { spec: next, notes } = checkForgeSpec(res.spec)
    const allNotes = [...(res.notes || []), ...notes.filter((n) => !(res.notes || []).includes(n))]
    if (glOK) houseRules(next, allNotes)
    const short = text.length > 70 ? text.slice(0, 68) + '…' : text
    setStatus(`${next.name}: ${next.parts.length} parts.`)
    commit(next, allNotes, mode === 'new' ? `Forged “${short}”` : `Changed: “${short}”`)
    renderAuth() // the first request may have just unlocked the Forge
    if (mode === 'new') frame(true)
    reviewNext = $('care').checked // Extra care: Claude also checks renders of every mode, once this one is on screen
    return true
  } catch (e) {
    setStatus(e.name === 'AbortError' ? 'Stopped.' : e.message, e.name !== 'AbortError')
    return false
  } finally {
    busy(false); renderAuth()
    if (reviewNext) { reviewNext = false; setTimeout(() => review(true), 300) }
  }
}

// ---------------------------------------------------------------------------------------------------- reference picture
let reference = null // { data: JPEG data URL, name }, kept for this visit only
let reviewNext = false
const REF_MAX_SIDE = 1280
/** Reads a picture the person picked, dropped or pasted, shrunk to a JPEG Claude can look at. */
async function loadReference(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return setStatus('Pick a PNG, JPEG or WebP picture.', true)
  if (file.size > 25 * 1024 * 1024) return setStatus('That picture is too big. Try one under 25 MB.', true)
  const url = URL.createObjectURL(file)
  try {
    const img = new Image(); img.src = url; await img.decode()
    const k = Math.min(1, REF_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height)
    reference = { data: c.toDataURL('image/jpeg', 0.86), name: file.name || 'pasted picture' }
    setStatus('Reference picture added. Describe anything to change, or just press Forge a new one.')
  } catch {
    setStatus('That picture could not be read. Try another.', true)
  } finally { URL.revokeObjectURL(url) }
  renderReference()
}
function renderReference() {
  $('refChip').hidden = !reference
  if (reference) { $('refThumb').src = reference.data; $('refName').textContent = reference.name.length > 28 ? reference.name.slice(0, 26) + '…' : reference.name }
  $('refAdd').textContent = reference ? 'Change picture' : 'Add a reference picture'
}

// ---------------------------------------------------------------------------------------------------- review pass
/**
 * Renders the design from the hero angle at rest and at each mode's full drive, the way teardown's critic reads
 * stills. The camera, the turntable and the studio go back to where they were.
 */
function captureStills() {
  const sp = spec(), modes = (sp.modes || []).filter((m) => m.id !== 'idle').slice(0, FORGE_CRITIQUE_MAX_STILLS - 1)
  const saved = { pos: camera.position.clone(), target: controls.target.clone(), turn: robot.rotation.y }
  robot.rotation.y = 0
  if (hero) {
    controls.target.copy(hero.target)
    camera.position.copy(hero.target).addScaledVector(new T.Vector3(0.36, 0.17, 0.92).normalize(), hero.dist)
    camera.lookAt(hero.target); rig.rotation.y = Math.atan2(camera.position.x - hero.target.x, camera.position.z - hero.target.z)
  }
  const shots = [{ label: 'At rest', pose: { idle: false } }, ...modes.map((m) => ({ label: `${m.name} at full drive`, pose: { mode: m.id, input: 1, idle: false } }))]
  const out = shots.map((x) => ({ label: x.label, image: captureRender(768, 'image/jpeg', x.pose) }))
  camera.position.copy(saved.pos); controls.target.copy(saved.target); robot.rotation.y = saved.turn; camera.lookAt(controls.target)
  return out
}
/** Claude looks at the stills and fixes what clashes, floats or hides; the fixed design becomes a new step. */
async function review(auto) {
  if (!caps.design || !glOK || !inner || ctl) return
  ctl = new AbortController(); busy(true, 'Claude is checking renders of every mode…')
  try {
    const res = await sessionPostJson('/api/forge/critique', { spec: spec(), stills: captureStills(), care: $('care').checked }, { scope: 'forge', signal: ctl.signal })
    const fixed = res.fixed || []
    if (!fixed.length) { setStatus(`Claude checked every mode${auto ? ' (Extra care)' : ''} and found nothing to fix.`); return }
    const { spec: next, notes } = checkForgeSpec(res.spec)
    const allNotes = [...fixed.map((f) => `Review: ${f}`), ...(res.notes || []), ...notes.filter((n) => !(res.notes || []).includes(n))]
    if (glOK) houseRules(next, allNotes)
    commit(next, allNotes, `Checked by Claude: ${fixed.length} fix${fixed.length > 1 ? 'es' : ''}`)
    const first = fixed[0].length > 140 ? fixed[0].slice(0, 138) + '…' : fixed[0]
    setStatus(`Claude fixed ${fixed.length} thing${fixed.length > 1 ? 's' : ''}: ${first}${fixed.length > 1 ? ' The rest are under House rules.' : ''}`)
  } catch (e) {
    setStatus(e.name === 'AbortError' ? 'Stopped.' : e.message, e.name !== 'AbortError')
  } finally { busy(false) }
}

async function photograph() {
  const s = step()
  if (!glOK || !s) return
  ctl = new AbortController(); busy(true, 'Photographing… this takes about half a minute.')
  try {
    await artReady()
    const res = await sessionPostJson('/api/forge/photo', { image: captureRender() }, { scope: 'forge', signal: ctl.signal })
    s.photo = { image: res.image, by: `${res.provider} · ${res.model}` }
    setStatus('Photo ready.')
    if (step() === s) showView('photo')
    renderHistory()
  } catch (e) {
    setStatus(e.name === 'AbortError' ? 'Stopped.' : e.message, e.name !== 'AbortError')
  } finally { busy(false); renderAuth(); renderPhoto() }
}

function busy(on, text) {
  if (!on) ctl = null // the request is over: nothing left to stop, and the console may tour again
  for (const id of ['forgeBtn', 'refineBtn', 'photoBtn', 'checkBtn']) { const b = $(id); if (b) b.disabled = on }
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
  for (const k of ['enamel', 'accent', 'glow']) {
    const K = k[0].toUpperCase() + k.slice(1)
    if (document.activeElement !== $('pick' + K)) $('pick' + K).value = spec().palette[k]
    $('hex' + K).textContent = spec().palette[k]
  }
}
/** Advanced colours: shows the raw pick live, then records it after the house range check. */
function wireColours() {
  for (const k of ['enamel', 'accent', 'glow']) {
    const K = k[0].toUpperCase() + k.slice(1), inp = $('pick' + K)
    inp.addEventListener('input', () => { $('hex' + K).textContent = inp.value; preview((x) => { x.palette[k] = inp.value }) })
    inp.addEventListener('change', () => {
      if (!spec()) return
      const want = inp.value.toLowerCase(), next = draft(); next.palette[k] = want
      const { spec: checked } = checkForgeSpec(next), got = checked.palette[k]
      commit(checked, step().house, `${K}: ${got}`, { keepSelection: true })
      setStatus(got === want ? '' : `${K} toned into the house range: ${want} became ${got}.`)
    })
  }
}
function renderAuth() {
  const a = account()?.address
  $('who').innerHTML = a
    ? `Signed in as <code>${esc(a.slice(0, 6))}…${esc(a.slice(-4))}</code>${hasSessionKey() ? ' · Forge unlocked for today' : ' · your wallet asks once, then the Forge runs for a day without asking'} · <button type="button" class="linkish" id="signOut">Sign out</button>`
    : 'Sign in with your wallet. It asks you to sign once, then the Forge runs for a day without asking. <button type="button" class="linkish" id="signInBtn">Sign in</button>'
  $('signOut')?.addEventListener('click', () => signOut())
  $('signInBtn')?.addEventListener('click', () => signIn().catch((e) => { if (e?.code !== 4001) setStatus(walletErrorMessage(e), true) }))
}
onAccountChange(renderAuth)
mountAuth()
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

/** One-line summaries on the collapsed panels, so their state reads without opening them. */
function renderBadges(sp) {
  const n = state.steps.length
  $('badgeHistory').textContent = `${n} step${n > 1 ? 's' : ''} · at ${state.cur + 1}`
  const w = sp.wear?.length || 0, d = sp.decals?.length || 0
  $('badgeSurfaces').textContent = [w ? `${w} weathering` : '', d ? `${d} decal${d > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || 'clean'
  $('badgeColours').innerHTML = ['enamel', 'accent', 'glow'].map((k) => `<i style="display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:-2px;margin-left:4px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2);background:${sp.palette[k]}"></i>`).join('')
  const h = (step().house || []).length
  $('badgeHouse').textContent = h ? `${h} fix${h > 1 ? 'es' : ''}` : 'all clear'
}
/** Panels open one at a time (native <details name> where supported, this as the fallback) and remember the last one. */
/**
 * The open panel grows to its content up to 600px (Surfaces fully open), then scrolls inside. A cap, not a size: a short
 * panel stays as tall as its content.
 */
const PANEL_MAX = 600
function sizePanels() {
  const host = $('panels'); if (!host) return
  host.style.setProperty('--panel-max', `${PANEL_MAX}px`)
}
function wirePanels() {
  const panels = [...document.querySelectorAll('#panels > details')]
  window.addEventListener('resize', sizePanels)
  new ResizeObserver(sizePanels).observe(document.querySelector('.forge-col'))
  let last = null
  try { last = localStorage.getItem('gremlins.forge.panel') } catch { /* private mode */ }
  if (last && $(last)) panels.forEach((d) => { d.open = d.id === last })
  for (const d of panels) d.addEventListener('toggle', () => {
    if (!d.open) return
    for (const o of panels) if (o !== d && o.open) o.open = false
    if (d.id !== 'panelSelection') try { localStorage.setItem('gremlins.forge.panel', d.id) } catch { /* private mode */ }
  })
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
  fitName()
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
  if ([...selected].some((i) => i >= sp.parts.length)) selected = new Set()
  renderBadges(sp)
  renderSwatches(); renderConfig(); renderPhoto(); renderHistory(); renderSurfaces(); renderInspector(); save(); thumbLater()
}

// ---------------------------------------------------------------------------------------------------- wiring
function wire() {
  let idea = -1
  $('ideaBtn').addEventListener('click', () => { idea = (idea + 1) % IDEAS.length; $('prompt').value = IDEAS[idea]; $('prompt').focus() })
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
    if (!t && !reference) return setStatus('Describe your gremlin first, add a reference picture, or pick an idea.', true)
    generate('new', t || 'Build the machine or creature in the reference picture as a gremlin.')
  })
  $('refFile').addEventListener('change', (e) => { loadReference(e.target.files[0]); e.target.value = '' })
  $('refClear').addEventListener('click', () => { reference = null; renderReference(); setStatus('') })
  const ask = $('askForm')
  ask.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); ask.classList.add('dragover') } })
  ask.addEventListener('dragleave', () => ask.classList.remove('dragover'))
  ask.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); loadReference(f) } ask.classList.remove('dragover') })
  $('prompt').addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); loadReference(f) } })
  $('checkBtn').addEventListener('click', () => review(false))
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
    const t = e.target, typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    if (typing) return
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); deleteSelected() }
      else if (e.key === 'Escape' && (selected.size || placing)) { placing = null; setSelection([]); renderSurfaces(); setStatus('') }
      return
    }
    if (e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo() }
  })
  $('name').addEventListener('input', (e) => { if (!spec()) return; spec().name = e.target.value.slice(0, 40); renderConfig(); renderHistory(); save() })
  wireColours()
  wirePanels()
  $('selMat').addEventListener('change', (e) => { const m = e.target.value; if (m) editSelected((p) => { if (p.mat) p.mat = m }, `Material: ${m}`) })
  $('selMirror').addEventListener('click', () => {
    const all = [...selected].every((i) => spec().parts[i].mirror)
    editSelected((p) => { if (all) delete p.mirror; else p.mirror = 'x' }, all ? 'Stopped mirroring' : 'Mirrored parts')
  })
  $('selDup').addEventListener('click', duplicateSelected)
  $('selDelete').addEventListener('click', deleteSelected)
  $('selClear').addEventListener('click', () => setSelection([]))
  $('selAll').addEventListener('click', () => setSelection(spec().parts.map((_, i) => i)))
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
  // The request boxes always show; without a designer on the server they explain why instead of sending.
  $('photoBtn').hidden = !caps.photo || !glOK
  $('checkBtn').hidden = !caps.design || !glOK
  $('offline').hidden = !!caps.design
}

document.getElementById('logo').innerHTML = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })
initStudio()
wire()
if (!step()) { const r = checkForgeSpec(structuredClone(FORGE_EXAMPLES.octopod)); state.steps = [{ spec: r.spec, house: r.notes, label: 'Example: Octopod', parent: -1, t: Date.now() }]; state.cur = 0 }
render(true)
renderAuth()
loadCaps()
