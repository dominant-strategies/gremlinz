/**
 * Record tour (teardown phase 5a): the tour rendered frame by frame at a fixed clock, so nothing drops however slow
 * the GPU, with the console's labels, mode and name painted into each frame, encoded to H.264 with WebCodecs and
 * packed into an MP4 in the browser. Nothing is uploaded.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'

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

/**
 * Encodes `frames` frames: `draw(i)` paints frame i onto `canvas` (and may be async). Returns the MP4 as a Blob.
 * `onProgress(done, total)` reports as it goes; aborting `signal` stops it.
 */
export async function encodeVideo({ canvas, frames, fps, draw, onProgress, signal }) {
  const cfg = await videoSupport(canvas.width, canvas.height, fps)
  if (!cfg) throw new Error('This browser can’t encode video. Try Chrome, Edge or Safari 17 or newer.')
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: canvas.width, height: canvas.height }, fastStart: 'in-memory' })
  let failed = null
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
  // the operating mode, big, bottom left
  if (o.mode) {
    ctx.fillStyle = signal
    ctx.font = `${17 * k}px ${mono}`; ctx.fillText('OPERATING MODE', pad, h - pad - 76 * k)
    ctx.font = `800 ${76 * k}px ${display}`; ctx.fillText(o.mode.toUpperCase(), pad, h - pad - 4 * k)
  }
  // credit
  ctx.textAlign = 'right'; ctx.fillStyle = muted; ctx.font = `${16 * k}px ${mono}`
  ctx.fillText('GREMLINZ.AI · GREMLIN FORGE', w - pad, h - pad)
  ctx.restore()
}
