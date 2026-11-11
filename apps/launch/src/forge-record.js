/**
 * Record tour (teardown phase 5a): the tour rendered frame by frame at a fixed clock, so nothing drops however slow
 * the GPU, with the console's labels, mode and name painted into each frame, encoded to H.264 with WebCodecs and
 * packed into an MP4 in the browser. Nothing is uploaded.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import QRCode from 'qrcode'

const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'] // High, Main, Baseline at level 4: 1080p

/** Whether this browser can encode the video, and with which codec. */
export async function videoSupport(width, height, fps) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null
  for (const codec of CODECS) {
    const cfg = { codec, width, height, bitrate: 10_000_000, framerate: fps, avc: { format: 'avc' } }
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg } catch { /* try the next */ }
  }
  return null
}

/** An audio codec this browser can encode, as the encoder and the muxer each name it: AAC first (plays everywhere), else Opus. */
export async function audioSupport(sampleRate, numberOfChannels) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null
  for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels, bitrate: 192_000 }
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, muxCodec } } catch { /* next */ }
  }
  return null
}

/** Encodes a whole AudioBuffer into the muxer's audio track. */
async function encodeAudio(buffer, cfg, muxer, onError) {
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: onError })
  enc.configure(cfg)
  const n = buffer.length, ch = buffer.numberOfChannels, step = 4800
  for (let i = 0; i < n; i += step) {
    const len = Math.min(step, n - i), data = new Float32Array(len * ch)
    for (let c = 0; c < ch; c++) data.set(buffer.getChannelData(c).subarray(i, i + len), c * len)
    const ad = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: len, numberOfChannels: ch, timestamp: Math.round((i / buffer.sampleRate) * 1e6), data })
    enc.encode(ad); ad.close()
  }
  await enc.flush(); enc.close()
}

/**
 * Encodes `frames` frames: `draw(i)` paints frame i onto `canvas` (and may be async). Returns the MP4 as a Blob.
 * `onProgress(done, total)` reports as it goes; aborting `signal` stops it.
 */
export async function encodeVideo({ canvas, frames, fps, draw, onProgress, signal, audio }) {
  const cfg = await videoSupport(canvas.width, canvas.height, fps)
  if (!cfg) throw new Error('This browser can’t encode video. Try Chrome, Edge or Safari 17 or newer.')
  const sound = audio ? await audioSupport(audio.sampleRate, audio.numberOfChannels) : null
  if (audio && !sound) throw new Error('This browser can’t encode the music. Try Chrome or Edge, or cut it without music.')
  const muxer = new Muxer({
    target: new ArrayBufferTarget(), fastStart: 'in-memory',
    video: { codec: 'avc', width: canvas.width, height: canvas.height },
    ...(sound ? { audio: { codec: sound.muxCodec, sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels } } : {}),
  })
  let failed = null
  // the music first: it's short work, and the muxer sorts the two tracks out when it finishes
  if (sound) await encodeAudio(audio, sound.cfg, muxer, (e) => { failed = e })
  if (failed) throw failed
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e } })
  encoder.configure(cfg)
  const us = 1e6 / fps
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      if (failed) throw failed
      await draw(i)
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * us), duration: Math.round(us) })
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
      frame.close()
      // let the encoder keep up instead of queueing the whole film in memory
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4))
      if (i % 6 === 0) { onProgress?.(i, frames); await new Promise((r) => setTimeout(r, 0)) }
    }
    await encoder.flush()
    if (failed) throw failed
    muxer.finalize()
    onProgress?.(frames, frames)
    return new Blob([muxer.target.buffer], { type: 'video/mp4' })
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}

/**
 * The console painted over a frame: the model badge and name top left, the operating mode bottom left, the labels with
 * their leader lines, and a small credit. Sizes follow teardown's rule: labels never under 34px tall at 1080p.
 */
export function paintOverlay(ctx, o) {
  const { w, h } = o, k = h / 1080, mono = '"JetBrains Mono", ui-monospace, monospace', display = '"Bricolage Grotesque", system-ui, sans-serif'
  const signal = '#e8571e', ink = '#24211d', muted = '#66625b'
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  // header: orange badge with the model code, then the name and tagline
  const pad = 44 * k
  ctx.font = `600 ${26 * k}px ${mono}`
  const codeW = ctx.measureText(o.code).width
  ctx.fillStyle = signal; ctx.fillRect(pad, pad, codeW + 48 * k, 84 * k)
  ctx.fillStyle = '#fff'; ctx.fillText(o.code, pad + 24 * k, pad + 53 * k)
  const x0 = pad + codeW + 72 * k
  ctx.fillStyle = muted; ctx.font = `${17 * k}px ${mono}`; ctx.fillText(o.kicker.toUpperCase(), x0, pad + 20 * k)
  ctx.fillStyle = ink; ctx.font = `800 ${56 * k}px ${display}`; ctx.fillText(o.name, x0, pad + 70 * k)
  const nameW = ctx.measureText(o.name).width
  ctx.fillStyle = signal; ctx.fillText('/', x0 + nameW + 14 * k, pad + 70 * k)
  if (o.tagline) { ctx.fillStyle = muted; ctx.font = `${18 * k}px ${mono}`; ctx.fillText(o.tagline.toUpperCase(), x0, pad + 100 * k) }
  // labels and leaders
  ctx.lineWidth = 1.5 * k
  for (const l of o.labels) {
    ctx.font = `600 ${22 * k}px ${mono}`
    const nw = ctx.measureText(l.name.toUpperCase()).width
    ctx.font = `${17 * k}px ${mono}`
    const sw = ctx.measureText(l.status).width
    const bw = Math.max(nw, sw) + 30 * k, bh = 62 * k
    const bx = l.left ? pad : w - pad - bw, by = Math.min(h - 200 * k, Math.max(170 * k, l.ly))
    const col = l.active ? signal : ink
    // leader: from the box edge, along, then into the part
    const x1 = l.left ? bx + bw : bx, y1 = by + bh / 2, elbow = l.left ? Math.min(l.x - 20 * k, x1 + 40 * k) : Math.max(l.x + 20 * k, x1 - 40 * k)
    ctx.strokeStyle = l.active ? signal : 'rgba(36,33,29,.55)'
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(elbow, y1); ctx.lineTo(l.x, l.y); ctx.stroke()
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(l.x, l.y, 5 * k, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = 'rgba(251,250,247,.94)'; ctx.fillRect(bx, by, bw, bh)
    ctx.fillStyle = col; ctx.fillRect(l.left ? bx : bx + bw - 4 * k, by, 4 * k, bh)
    ctx.textAlign = l.left ? 'left' : 'right'
    const tx = l.left ? bx + 16 * k : bx + bw - 16 * k
    ctx.fillStyle = ink; ctx.font = `600 ${22 * k}px ${mono}`; ctx.fillText(l.name.toUpperCase(), tx, by + 27 * k)
    ctx.fillStyle = l.active ? signal : muted; ctx.font = `${17 * k}px ${mono}`; ctx.fillText(l.status, tx, by + 50 * k)
    ctx.textAlign = 'left'
  }
  if (o.card?.kind === 'closer') paintCloser(ctx, o.card, w, h, k, { mono, display, signal, ink, muted })
  else if (o.card) paintCard(ctx, o.card, w, h, k, { mono, display, signal, ink })
  // the operating mode, big, bottom left
  if (o.mode) {
    // the title, big, with the optional sentence under it (wrapped to two lines at most) and the kicker above
    ctx.font = `${21 * k}px ${mono}`
    const cap = o.caption ? wrap(ctx, o.caption, Math.min(w * 0.5, 900 * k)).slice(0, 2) : []
    const capH = cap.length * 30 * k + (cap.length ? 14 * k : 0)
    ctx.fillStyle = signal
    ctx.font = `${17 * k}px ${mono}`; ctx.fillText(o.modeKicker || 'OPERATING MODE', pad, h - pad - 76 * k - capH)
    ctx.font = `800 ${76 * k}px ${display}`; ctx.fillText(o.mode.toUpperCase(), pad, h - pad - 4 * k - capH)
    ctx.fillStyle = ink; ctx.font = `${21 * k}px ${mono}`
    cap.forEach((line, i) => ctx.fillText(line, pad, h - pad - capH + 14 * k + 22 * k + i * 30 * k))
  }
  // credit (not on the closer, which carries its own link)
  if (o.card?.kind === 'closer') { ctx.restore(); return }
  ctx.textAlign = 'right'; ctx.fillStyle = muted; ctx.font = `${16 * k}px ${mono}`
  ctx.fillText('GREMLINZ.AI · GREMLIN FORGE', w - pad, h - pad)
  ctx.restore()
}

/** Words wrapped to `max` pixels wide in the current font. */
function wrap(ctx, text, max) {
  const out = []
  let line = ''
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > max) { out.push(line); line = word } else line = next
  }
  if (line) out.push(line)
  return out
}

/**
 * A title card: its life goals (numbered) or its motive, in a pale panel with an accent rule, on the side the camera
 * left free, faded by `card.alpha`. Type is large enough to read on a phone at 1080p.
 */
function paintCard(ctx, card, w, h, k, f) {
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, card.alpha))
  const bw = Math.min(w * 0.42, 820 * k), x = card.left ? w * 0.06 : w - w * 0.06 - bw, padX = 40 * k, inner = bw - padX * 2
  const motive = card.kind === 'motive'
  const size = motive ? 54 * k : 46 * k, lh = size * 1.18
  ctx.font = `800 ${size}px ${f.display}`
  const blocks = motive ? [wrap(ctx, card.lines[0] || '', inner)] : card.lines.map((g) => wrap(ctx, g, inner - 64 * k))
  const textH = blocks.reduce((a, b) => a + b.length * lh, 0) + (blocks.length - 1) * 22 * k
  const bh = textH + 112 * k, y = (h - bh) / 2
  ctx.fillStyle = 'rgba(251,250,247,.9)'; ctx.fillRect(x, y, bw, bh)
  ctx.fillStyle = f.signal; ctx.fillRect(x, y, 6 * k, bh)
  ctx.font = `600 ${20 * k}px ${f.mono}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  ctx.fillText((motive ? 'WHY IT EXISTS' : 'LIFE GOALS').split('').join(String.fromCharCode(8202)), x + padX, y + 52 * k)
  let ty = y + 84 * k + size * 0.85
  ctx.font = `800 ${size}px ${f.display}`
  blocks.forEach((lines, i) => {
    if (!motive) { ctx.fillStyle = f.signal; ctx.font = `600 ${22 * k}px ${f.mono}`; ctx.fillText(String(i + 1).padStart(2, '0'), x + padX, ty - 6 * k); ctx.font = `800 ${size}px ${f.display}` }
    ctx.fillStyle = f.ink
    for (const line of lines) { ctx.fillText(line, x + padX + (motive ? 0 : 64 * k), ty); ty += lh }
    ty += 22 * k
  })
  ctx.restore()
}

/** Draws `text` as a QR code, `size` pixels square with its quiet zone, dark modules in `ink` on white. */
export function drawQr(ctx, text, x, y, size, ink = '#24211d') {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = modules.size, quiet = 2, cell = size / (n + quiet * 2)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, size, size)
  ctx.fillStyle = ink
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (modules.get(r, c)) ctx.fillRect(Math.floor(x + (c + quiet) * cell), Math.floor(y + (r + quiet) * cell), Math.ceil(cell), Math.ceil(cell))
}

/** The call to action the film ends on: the headline, a QR code big enough to scan off a phone screen, and the link. */
function paintCloser(ctx, card, w, h, k, f) {
  const [headline, url] = card.lines
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, card.alpha))
  const bw = Math.min(w * 0.44, 840 * k), x = w * 0.06, padX = 44 * k, inner = bw - padX * 2
  ctx.font = `800 ${62 * k}px ${f.display}`
  const lines = headline ? wrap(ctx, headline, inner).slice(0, 3) : []
  const qr = Math.min(300 * k, inner * 0.62)
  const bh = 70 * k + lines.length * 70 * k + 24 * k + qr + 84 * k, y = (h - bh) / 2
  ctx.fillStyle = 'rgba(251,250,247,.94)'; ctx.fillRect(x, y, bw, bh)
  ctx.fillStyle = f.signal; ctx.fillRect(x, y, 6 * k, bh)
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  let ty = y + 52 * k
  ctx.font = `600 ${20 * k}px ${f.mono}`; ctx.fillText('SCAN TO MEET IT', x + padX, ty)
  ty += 18 * k
  ctx.fillStyle = f.ink; ctx.font = `800 ${62 * k}px ${f.display}`
  for (const line of lines) { ty += 64 * k; ctx.fillText(line, x + padX, ty) }
  ty += 30 * k
  drawQr(ctx, url, x + padX, ty, qr, f.ink)
  ctx.fillStyle = f.signal; ctx.font = `600 ${24 * k}px ${f.mono}`
  const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  ctx.fillText(shown.length > 48 ? shown.slice(0, 46) + '…' : shown, x + padX, ty + qr + 46 * k)
  ctx.restore()
}
