/**
 * The film's music. Either a score synthesised here, in the browser, to fit the cut it goes with (a hit on every new
 * shot, a build into the exploded view, a last chord that rings under the closer), so every film gets its own and no
 * licence is needed; or a track of the maker's own, trimmed to the film with fades. Rendered offline, sample-exact,
 * then encoded into the MP4 next to the pictures (forge-record.js).
 */
export const MUSIC_RATE = 48000

const MINOR = [0, 2, 3, 5, 7, 8, 10], MAJOR = [0, 2, 4, 5, 7, 9, 11]
/** Each style: tempo, key (MIDI root), scale, chord degrees, bars per chord, and which parts play. */
const STYLES = {
  pulse: { bpm: 100, root: 45, scale: MINOR, prog: [0, 5, 3, 6], bars: 1, kick: 'four', snare: true, hat: 8, bass: 8, pad: 0.05, cutoff: 1500, arp: false, bell: false },
  ominous: { bpm: 68, root: 38, scale: MINOR, prog: [0, 5, 0, 6], bars: 2, kick: 'half', snare: false, hat: 0, bass: 1, pad: 0.06, cutoff: 650, arp: false, bell: false, drone: true },
  bright: { bpm: 122, root: 48, scale: MAJOR, prog: [0, 4, 5, 3], bars: 1, kick: 'four', snare: true, hat: 16, bass: 4, pad: 0.035, cutoff: 2600, arp: true, bell: false },
  ambient: { bpm: 72, root: 43, scale: MAJOR, prog: [0, 3, 5, 4], bars: 2, kick: null, snare: false, hat: 0, bass: 1, pad: 0.06, cutoff: 1200, arp: false, bell: true },
}
export const musicStyles = () => Object.keys(STYLES)

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12)
/** A seeded random source, so the same cut always gets the same score. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

/**
 * Renders a score for `beats` (forgeTour) in `style`; resolves to a stereo AudioBuffer exactly `seconds` long.
 * `seed` varies the details between films of the same cut.
 */
export async function renderScore(beats, style, seconds, seed = 1) {
  const S = STYLES[style]
  if (!S) return null
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * MUSIC_RATE), MUSIC_RATE)
  const rand = rng(seed)
  // mix: everything into a compressor, a send to a generated room, then a master with the fades
  const master = ctx.createGain(), comp = ctx.createDynamicsCompressor(), verb = ctx.createConvolver(), send = ctx.createGain()
  comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2
  verb.buffer = roomImpulse(ctx, style === 'ominous' || style === 'ambient' ? 3.2 : 1.8, rand)
  send.gain.value = style === 'ambient' ? 0.55 : 0.3
  send.connect(verb); verb.connect(comp); comp.connect(master); master.connect(ctx.destination)
  master.gain.setValueAtTime(0, 0); master.gain.linearRampToValueAtTime(1, 0.06)
  master.gain.setValueAtTime(1, Math.max(0.1, seconds - 1.6)); master.gain.linearRampToValueAtTime(0, seconds)
  const noise = noiseBuffer(ctx, rand)
  const out = (node, wet = 0) => { node.connect(comp); if (wet) { const g = ctx.createGain(); g.gain.value = wet; node.connect(g); g.connect(send) } }

  // ── instruments ──
  const kick = (t, level = 0.9) => {
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.setValueAtTime(style === 'ominous' ? 110 : 150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14)
    g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + (style === 'ominous' ? 0.7 : 0.35))
    o.connect(g); out(g); o.start(t); o.stop(t + 0.8)
  }
  const burst = (t, { freq, type = 'highpass', q = 0.7, level, decay, wet = 0 }) => {
    const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain()
    n.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q
    g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay)
    n.connect(f); f.connect(g); out(g, wet); n.start(t, rand() * 1.5); n.stop(t + decay + 0.05)
  }
  const tone = (t, midi, dur, { type = 'sawtooth', level = 0.1, attack = 0.01, release = 0.15, cutoff = S.cutoff, detune = 0, wet = 0 }) => {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain()
    o.type = type; o.frequency.value = hz(midi); o.detune.value = detune
    f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.8
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + attack)
    g.gain.setValueAtTime(level, t + Math.max(attack, dur - release)); g.gain.linearRampToValueAtTime(0, t + dur + release)
    o.connect(f); f.connect(g); out(g, wet); o.start(t); o.stop(t + dur + release + 0.05)
  }
  const bell = (t, midi, level = 0.05) => {
    for (const [ratio, l, d] of [[1, 1, 3.5], [2.76, 0.35, 1.6], [5.4, 0.12, 0.8]]) {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = hz(midi) * ratio
      g.gain.setValueAtTime(level * l, t); g.gain.exponentialRampToValueAtTime(0.0005, t + d)
      o.connect(g); out(g, 0.8); o.start(t); o.stop(t + d + 0.05)
    }
  }
  /** A hit on a new shot: a low boom and a filtered crack, into the room. */
  const hit = (t, big = false) => {
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.setValueAtTime(big ? 70 : 85, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.6)
    g.gain.setValueAtTime(big ? 0.75 : 0.45, t); g.gain.exponentialRampToValueAtTime(0.001, t + (big ? 1.4 : 0.8))
    o.connect(g); out(g, 0.4); o.start(t); o.stop(t + 1.5)
    burst(t, { freq: style === 'bright' ? 3000 : 1400, type: 'bandpass', q: 0.6, level: big ? 0.35 : 0.2, decay: big ? 0.9 : 0.45, wet: 0.7 })
  }
  /** A riser into `t1`: filtered noise sweeping up and swelling. */
  const riser = (t0, t1) => {
    const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain()
    n.buffer = noise; n.loop = true; f.type = 'bandpass'; f.Q.value = 1.2
    f.frequency.setValueAtTime(300, t0); f.frequency.exponentialRampToValueAtTime(7000, t1)
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.22, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1 + 0.04)
    n.connect(f); f.connect(g); out(g, 0.5); n.start(t0); n.stop(t1 + 0.1)
  }

  // ── the arrangement, on the film's own clock ──
  const beat = 60 / S.bpm, bar = beat * 4, chordLen = bar * S.bars
  const chord = (deg, octave = 0) => [0, 2, 4].map((k) => { const i = deg + k; return S.root + 12 + octave * 12 + S.scale[i % 7] + 12 * Math.floor(i / 7) })
  const total = seconds - 0.5
  // quiet for the first half second, drums in after the first bar, everything settles under the last beat
  const last = beats[beats.length - 1], finale = last?.card === 'closer' ? last.at : Math.max(0, seconds - 3)
  for (let i = 0, t = 0; t < total; i++, t += chordLen) {
    const deg = S.prog[i % S.prog.length], notes = chord(deg), end = Math.min(chordLen, seconds - t)
    if (t >= finale) break
    for (const m of notes) for (const dt of [-7, 7]) tone(t, m, end - 0.05, { level: S.pad, attack: style === 'ambient' ? 1.2 : 0.35, release: 0.6, detune: dt, wet: 0.6 })
    if (S.drone) tone(t, S.root - 12 + S.scale[deg % 7], end, { type: 'sawtooth', level: 0.09, attack: 0.8, release: 1, cutoff: 220 })
    // bass: on every eighth, every beat, or one long note per chord
    const bassNote = S.root + S.scale[deg % 7], steps = S.bass === 1 ? 1 : S.bass === 4 ? 4 * S.bars : 8 * S.bars, step = chordLen / steps
    for (let k = 0; k < steps; k++) if (t + k * step < finale) tone(t + k * step, bassNote + (S.bass === 8 && k % 2 ? 12 : 0), step * (S.bass === 1 ? 1 : 0.8), { level: S.bass === 1 ? 0.16 : 0.13, cutoff: S.bass === 1 ? 300 : 700, attack: S.bass === 1 ? 0.3 : 0.005, release: 0.08 })
    if (S.arp) for (let k = 0; k < 8 * S.bars; k++) { const tt = t + k * (beat / 2); if (tt < finale) tone(tt, notes[k % 3] + 12, beat * 0.4, { type: 'triangle', level: 0.05, release: 0.12, cutoff: 5000, wet: 0.3 }) }
    if (S.bell && i % 2 === 0) bell(t + beat * (1 + Math.floor(rand() * 2)), notes[Math.floor(rand() * 3)] + 12)
    // drums from the second bar
    for (let b = 0; b < 4 * S.bars; b++) {
      const tt = t + b * beat
      if (tt < bar || tt >= finale) continue
      if (S.kick === 'four' || (S.kick === 'half' && b % 2 === 0)) kick(tt)
      if (S.snare && b % 2 === 1) burst(tt, { freq: 1800, type: 'bandpass', q: 0.9, level: 0.3, decay: 0.18, wet: 0.3 })
      if (S.hat) for (let h = 0; h < S.hat / 4; h++) burst(tt + h * (beat / (S.hat / 4)), { freq: 7500, level: h % 2 ? 0.05 : 0.08, decay: 0.045 })
    }
  }
  // hits where the film cuts to a new shot; a riser into the exploded view; a big one on the closer
  let prevTake = beats[0]?.take
  for (const b of beats) {
    if (b.take !== prevTake && b.at > 0.5) {
      if (b.label === 'Exploded' && b.explode[1] > 0) riser(Math.max(0, b.at - 1.6), b.at)
      hit(b.at, b.label === 'Exploded' || b.card === 'closer')
    }
    prevTake = b.take
  }
  // the last chord rings out under the finale
  if (finale < seconds) {
    const notes = chord(S.prog[0])
    for (const m of [S.root, ...notes, notes[0] + 12]) tone(finale, m, seconds - finale - 0.2, { level: S.pad * 1.3, attack: 0.05, release: 1.2, cutoff: S.cutoff * 1.4, wet: 0.8 })
    if (S.bell) bell(finale, notes[2] + 12, 0.07)
  }
  return normalize(await ctx.startRendering())
}

/** A track of the maker's own, decoded and fitted to the film: trimmed (or looped) to `seconds`, a short fade in, a long fade out. */
export async function fitTrack(file, seconds) {
  const raw = await file.arrayBuffer()
  const decoded = await new OfflineAudioContext(2, MUSIC_RATE, MUSIC_RATE).decodeAudioData(raw)
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * MUSIC_RATE), MUSIC_RATE)
  const src = ctx.createBufferSource(), g = ctx.createGain()
  src.buffer = decoded
  src.loop = decoded.duration < seconds // a short track loops rather than leaving the end silent
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, 0.3)
  g.gain.setValueAtTime(1, Math.max(0.4, seconds - 2)); g.gain.linearRampToValueAtTime(0, seconds)
  src.connect(g); g.connect(ctx.destination); src.start(0)
  return normalize(await ctx.startRendering())
}

/** Peak-normalises to -1 dBFS (and never boosts a silent buffer). */
function normalize(buf) {
  let peak = 0
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v } }
  if (peak > 0.001) { const k = 0.89 / peak; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k } }
  return buf
}
function noiseBuffer(ctx, rand) {
  const b = ctx.createBuffer(1, MUSIC_RATE * 2, MUSIC_RATE), d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1
  return b
}
/** A room: decaying stereo noise, a little darker as it fades. */
function roomImpulse(ctx, secs, rand) {
  const n = Math.floor(secs * MUSIC_RATE), b = ctx.createBuffer(2, n, MUSIC_RATE)
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < n; i++) { const k = i / n; lp += ((rand() * 2 - 1) - lp) * (0.5 - 0.42 * k); d[i] = lp * (1 - k) ** 2.4 } }
  return b
}

/** Plays a buffer in the page (the dialog's preview); returns a stop function. */
export function playPreview(buffer, from = 0) {
  const ctx = new AudioContext()
  const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(ctx.destination); src.start(0, from)
  const stop = () => { try { src.stop() } catch { /* already stopped */ } ctx.close() }
  src.onended = () => ctx.close().catch(() => {})
  return stop
}
