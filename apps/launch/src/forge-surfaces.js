/**
 * Gremlin Forge surfaces: weathering (rust, grime, soot, scratches, patina, chipped paint, oil) painted on in the
 * shader from 3D noise in the robot's own space, so it lands in spots and streaks on any shape without UVs; and decals,
 * SVG artwork or uploaded pictures projected onto the body where a ray from `at` along `dir` meets it.
 */
import * as T from 'three'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'

// ---------------------------------------------------------------------------------------------------- wear

/** Look of each wear kind: two colours to vary between, and what it does to roughness, metalness, bump and clear coat. */
const WEAR = {
  rust: { a: '#4a1c0b', b: '#b4561f', rough: 0.95, metal: 0.05, bump: 1, coat: 0, lines: 0 },
  grime: { a: '#2b241a', b: '#5d4d36', rough: 0.85, metal: 0.1, bump: 0.2, coat: 0.25, lines: 0 },
  soot: { a: '#0b0a09', b: '#26231f', rough: 0.97, metal: 0, bump: 0.08, coat: 0.15, lines: 0 },
  scratches: { a: '#8f9397', b: '#e2e4e6', rough: 0.28, metal: 1, bump: -0.35, coat: 0, lines: 1 },
  patina: { a: '#2f7a66', b: '#9ad3bc', rough: 0.88, metal: 0.05, bump: 0.45, coat: 0, lines: 0 },
  chipped: { a: '#5f6368', b: '#a3a7ab', rough: 0.42, metal: 0.92, bump: -0.6, coat: 0, lines: 0 },
  oil: { a: '#050403', b: '#1d150c', rough: 0.06, metal: 0, bump: 0.05, coat: 1, lines: 0 },
}
const PATTERN = { spots: 0, streaks: 1, patches: 2, bottom: 3, all: 4 }
export const WEAR_MAX = 4
/** Shared by every weathered material: the inverse of the robot's world matrix, so the noise turns with the robot. */
export const wearFrame = { value: new T.Matrix4() }

// Ashima Arts 3D simplex noise (MIT), then the per-layer masks.
const NOISE = /* glsl */ `
vec3 w_mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 w_mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 w_perm(vec4 x){return w_mod289(((x*34.0)+10.0)*x);}
float w_snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=w_mod289(i);
  vec4 p=w_perm(w_perm(w_perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float w_fbm(vec3 p){ float f=0.0, a=0.5; for(int i=0;i<5;i++){ f+=a*w_snoise(p); p=p*2.03+vec3(17.1,3.7,9.2); a*=0.5; } return f; }

uniform int uWearN;
uniform vec3 uWearA[${WEAR_MAX}];
uniform vec3 uWearB[${WEAR_MAX}];
uniform vec4 uWearP[${WEAR_MAX}]; // amount, scale, seed, pattern
uniform vec4 uWearM[${WEAR_MAX}]; // roughness, metalness, bump, clear coat kept
uniform float uWearL[${WEAR_MAX}]; // 1 = scratch lines
varying vec3 vWearPos;
float wM[${WEAR_MAX}];
float wH;

// n01 sits around 0.5 with a spread of roughly 0.12, so the threshold slides from 0.66 (a few marks) to 0.34 (most of it).
float w_layer(int i, vec3 p, out float h, out float v){
  vec4 P=uWearP[i]; float amount=P.x, sc=P.y; int pat=int(P.w+0.5);
  vec3 q=p+P.z*1.37;
  float t=mix(0.67,0.33,amount), m;
  float fine=w_snoise(q*26.0*sc);
  if(pat==0){ float n=w_fbm(q*3.4*sc)*0.5+0.5+fine*0.02; m=smoothstep(t,t+0.05,n); }
  else if(pat==1){ float n=w_fbm(vec3(q.x*7.0,q.y*0.8,q.z*7.0)*sc)*0.5+0.5+fine*0.02; m=smoothstep(t,t+0.07,n); }
  else if(pat==2){ float n=w_fbm(q*1.3*sc)*0.5+0.5+fine*0.03; m=smoothstep(t,t+0.09,n); }
  else if(pat==3){ float n=w_fbm(q*2.6*sc)*0.5+0.5+fine*0.03; float up=clamp(p.y/2.4,0.0,1.0); m=smoothstep(t,t+0.06,n+0.42-up*0.85); }
  else { float n=w_fbm(q*2.0*sc)*0.5+0.5; m=clamp(amount*(0.55+(n-0.5)*2.2),0.0,1.0); }
  if(uWearL[i]>0.5){
    float s1=abs(w_snoise(vec3(q.x*3.0+q.z*2.0,q.y*60.0*sc,q.z*3.0)));
    float s2=abs(w_snoise(vec3(q.x*55.0*sc,(q.y+q.z)*2.5,q.z*55.0*sc)+7.0));
    m*=max(1.0-smoothstep(0.0,0.05,s1),1.0-smoothstep(0.0,0.04,s2));
  }
  h=smoothstep(0.0,1.0,m);
  v=clamp(w_snoise(q*6.0)*0.5+0.5+fine*0.15,0.0,1.0);
  return m;
}
`

function wearUniforms(layers) {
  const pad = (f, d) => Array.from({ length: WEAR_MAX }, (_, i) => (layers[i] ? f(layers[i]) : d()))
  return {
    uWearFrame: wearFrame,
    uWearN: { value: layers.length },
    uWearA: { value: pad((l) => new T.Color(WEAR[l.kind].a), () => new T.Color()) },
    uWearB: { value: pad((l) => new T.Color(WEAR[l.kind].b), () => new T.Color()) },
    uWearP: { value: pad((l) => new T.Vector4(l.amount, l.scale, l.seed, PATTERN[l.pattern] ?? 0), () => new T.Vector4()) },
    uWearM: { value: pad((l) => { const k = WEAR[l.kind]; return new T.Vector4(k.rough, k.metal, k.bump, k.coat) }, () => new T.Vector4()) },
    uWearL: { value: pad((l) => WEAR[l.kind].lines, () => 0) },
  }
}

/** A copy of a standard or physical material with the wear layers painted on. */
export function wearMaterial(base, layers) {
  const m = base.clone()
  const uniforms = wearUniforms(layers.slice(0, WEAR_MAX))
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    sh.vertexShader = 'uniform mat4 uWearFrame;\nvarying vec3 vWearPos;\n' + sh.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvWearPos = (uWearFrame * modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <color_fragment>', `#include <color_fragment>
        wH = 0.0;
        for (int i = 0; i < ${WEAR_MAX}; i++) {
          wM[i] = 0.0;
          if (i >= uWearN) continue;
          float h, v; float m = w_layer(i, vWearPos, h, v);
          wM[i] = m; wH += h * uWearM[i].z;
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(uWearA[i], uWearB[i], v), m);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        for (int i = 0; i < ${WEAR_MAX}; i++) roughnessFactor = mix(roughnessFactor, uWearM[i].x, wM[i]);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        for (int i = 0; i < ${WEAR_MAX}; i++) metalnessFactor = mix(metalnessFactor, uWearM[i].y, wM[i]);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec2 dh = vec2(dFdx(wH), dFdy(wH)) * 0.006;
          normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2));
        }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          for (int i = 0; i < ${WEAR_MAX}; i++) material.clearcoat *= mix(1.0, uWearM[i].w, wM[i]);
        #endif`)
  }
  m.customProgramCacheKey = () => 'forge-wear'
  return m
}

/** The wear layers that land on one material of one part: the part's own first, then matching top-level layers. */
export function wearFor(spec, part, matName) {
  if (matName === 'glow') return []
  const fromSpec = (spec.wear || []).filter((w) => !w.on || w.on.includes(matName))
  let layers = [...(part.wear || []), ...fromSpec]
  if (matName === 'glass') layers = layers.filter((w) => ['grime', 'soot', 'oil'].includes(w.kind))
  return layers.slice(0, WEAR_MAX)
}

// ---------------------------------------------------------------------------------------------------- decal art

const textures = new Map() // source string -> { tex, aspect, ready }

function svgAspect(svg) {
  const m = /<svg[^>]*\sviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(svg)
  const w = m ? Number(m[1]) : 1, h = m ? Number(m[2]) : 1
  return w > 0 && h > 0 ? Math.min(8, Math.max(1 / 8, w / h)) : 1
}

/**
 * A texture for a decal, drawn once the image has decoded. SVG goes through an <img>, which runs no scripts and loads
 * nothing external, so even unchecked artwork can't reach the page.
 */
export function artTexture(src, aspectHint) {
  let t = textures.get(src)
  if (t) return t
  const isSvg = src.trimStart().startsWith('<svg')
  const aspect = isSvg ? svgAspect(src) : aspectHint || 1
  const W = aspect >= 1 ? 1024 : Math.round(1024 * aspect), H = aspect >= 1 ? Math.round(1024 / aspect) : 1024
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 8
  const img = new Image()
  const ready = new Promise((resolve) => {
    img.onload = () => { try { canvas.getContext('2d').drawImage(img, 0, 0, W, H); tex.needsUpdate = true } catch { /* undrawable */ } resolve() }
    img.onerror = () => resolve()
  })
  if (isSvg) {
    const sized = src.replace(/^<svg\b([^>]*)>/i, (_, attrs) => `<svg${attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '')} width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet">`)
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized)
  } else img.src = src
  t = { tex, aspect, ready }
  textures.set(src, t)
  return t
}

/** Resolves when every decal texture made so far has drawn (or failed), so a capture never catches a blank decal. */
export const artReady = () => Promise.all([...textures.values()].map((t) => t.ready))

// ---------------------------------------------------------------------------------------------------- decals

function decalMaterial(finish, map, glow) {
  const common = { map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: T.DoubleSide }
  if (finish === 'glow') return new T.MeshBasicMaterial({ ...common, color: new T.Color(1.6, 1.6, 1.6), toneMapped: false })
  if (finish === 'etched') return new T.MeshStandardMaterial({ ...common, color: '#7b7b7b', metalness: 1, roughness: 0.62, envMapIntensity: 1.2 })
  if (finish === 'sticker') return new T.MeshStandardMaterial({ ...common, roughness: 0.55 })
  if (finish === 'ink') return new T.MeshPhysicalMaterial({ ...common, opacity: 0.88, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 })
  void glow
  return new T.MeshPhysicalMaterial({ ...common, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.05 })
}

/**
 * Projects the spec's decals onto `inner` (the built parts, in design coordinates) and adds them to `root`, whose world
 * matrix must be the identity while this runs. Returns how many decals missed or had no picture.
 */
export function addDecals(spec, inner, root, uploads, worldScale) {
  const decals = spec.decals || []
  if (!decals.length) return { missed: 0, missingPictures: 0 }
  const targets = []
  inner.traverse((n) => { if (n.isMesh && !n.userData.glow) targets.push(n) })
  const ray = new T.Raycaster(), helper = new T.Object3D()
  let missed = 0, missingPictures = 0
  for (const d of decals) {
    let src, hint
    if (d.art) src = spec.art?.[d.art]
    else if (d.image) { const u = uploads[d.image.slice(7)]; if (u) { src = u.data; hint = u.aspect } }
    if (!src) { if (d.image) missingPictures++; else missed++; continue }
    const art = artTexture(src, hint)
    for (const sx of d.mirror === 'x' ? [1, -1] : [1]) {
      const at = inner.localToWorld(new T.Vector3(d.at[0] * sx, d.at[1], d.at[2]))
      const dir = new T.Vector3(d.dir[0] * sx, d.dir[1], d.dir[2]).transformDirection(inner.matrixWorld)
      ray.set(at.clone().addScaledVector(dir, 3), dir.clone().negate())
      let best = null
      for (const h of ray.intersectObjects(targets, false)) {
        if (!h.face) continue
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld)
        if (n.dot(dir) < 0.05) continue // the inside of a surface
        const dist = h.point.distanceTo(at)
        if (!best || dist < best.dist) best = { h, n, dist }
      }
      if (!best) { missed++; continue }
      const w = d.size * worldScale, hgt = w / art.aspect
      helper.position.copy(best.h.point); helper.lookAt(best.h.point.clone().add(best.n)); helper.rotateZ(-d.rot * Math.PI / 180)
      const geo = new DecalGeometry(best.h.object, best.h.point, helper.rotation.clone(), new T.Vector3(w, hgt, Math.max(w, hgt) * 0.6))
      if (!geo.attributes.position || !geo.attributes.position.count) { geo.dispose(); missed++; continue }
      let mat = decalMaterial(d.finish, art.tex)
      const under = best.h.object.userData.wear
      if (under && under.length && ['paint', 'ink', 'sticker'].includes(d.finish)) { const wm = wearMaterial(mat, under); mat.dispose(); mat = wm }
      const m = new T.Mesh(geo, mat); m.receiveShadow = true; m.userData.decal = true; m.renderOrder = 1
      root.add(m)
    }
  }
  return { missed, missingPictures }
}
