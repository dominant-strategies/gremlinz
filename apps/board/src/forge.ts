/**
 * Gremlin Forge backends: Claude designs the 3D body, an image model turns the studio render into a photo.
 * Both are optional; each is enabled by its API key in the environment and reported by GET /api/forge.
 */
import Anthropic from '@anthropic-ai/sdk'
import { FORGE_CRITIQUE_MAX_STILLS, FORGE_PHOTO_PROMPT, checkForgeCut, checkForgeSpec, checkStory, forgeCritiquePrompt, forgeCutPrompt, forgeDesignPrompt, parseModelJson, type ForgeCut, type ForgeSpec } from '@gremlins/hatch'

export class ForgeError extends Error {
  readonly status: 400 | 502 | 503
  constructor(message: string, status: 400 | 502 | 503 = 502) {
    super(message)
    this.status = status
  }
}

// ------------------------------------------------------------------------------------------------ design (Claude)

/** A picture for the model to look at: a reference to design from, or a render to review. */
export interface ForgeImage { mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: string /* base64 */ }
export interface ForgeDesigner {
  /** Returns the model's raw reply text for a prompt built by `forgeDesignPrompt` or `forgeCritiquePrompt`. */
  complete(prompt: string, opts: { care: boolean; signal?: AbortSignal; images?: ForgeImage[] }): Promise<string>
}

export const FORGE_MODEL = 'claude-opus-5-5'

/** Claude through the official SDK. Credentials resolve the SDK's usual way (ANTHROPIC_API_KEY, etc.). */
export function claudeDesigner(client = new Anthropic()): ForgeDesigner {
  return {
    async complete(prompt, { care, signal, images = [] }) {
      // pictures first, then the words that talk about them
      const content = [
        ...images.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mime, data: im.data } })),
        { type: 'text' as const, text: prompt },
      ]
      const message = await client.beta.messages
        .stream(
          {
            model: FORGE_MODEL,
            max_tokens: 32000,
            thinking: { type: 'adaptive' },
            output_config: { effort: care ? 'high' : 'medium' },
            // Route policy declines to a fallback model instead of failing the forge.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            messages: [{ role: 'user', content }],
          },
          { signal },
        )
        .finalMessage()
      if (message.stop_reason === 'refusal') throw new ForgeError('Claude declined that description. Try describing it differently.', 400)
      if (message.stop_reason === 'max_tokens') throw new ForgeError('The design ran too long. Try a simpler description.')
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      if (!text.trim()) throw new ForgeError('Claude returned no design.')
      return text
    },
  }
}

/** Runs one design request end to end: prompt → model → JSON → house-style check. */
export async function designGremlin(
  designer: ForgeDesigner,
  req: { mode: 'new' | 'refine'; text: string; spec?: unknown; care?: boolean; uploads?: { id: string; label: string }[]; reference?: string },
  signal?: AbortSignal,
): Promise<{ spec: ForgeSpec; notes: string[] }> {
  const images = req.reference ? [decodeImage(req.reference, 'reference picture')] : []
  let current: ForgeSpec | undefined
  if (req.mode === 'refine') {
    if (!req.spec) throw new ForgeError('A change needs the current design.', 400)
    current = checkForgeSpec(req.spec).spec
  }
  const text = await ask(designer, forgeDesignPrompt(req.mode, req.text, current, req.uploads, { reference: images.length > 0 }), { care: !!req.care, signal, images })
  try {
    return checkForgeSpec(parseModelJson(text))
  } catch (e) {
    throw new ForgeError((e as Error).message)
  }
}

async function ask(designer: ForgeDesigner, prompt: string, opts: Parameters<ForgeDesigner['complete']>[1]): Promise<string> {
  try {
    return await designer.complete(prompt, opts)
  } catch (e) {
    if (e instanceof ForgeError) throw e
    if (e instanceof Anthropic.RateLimitError) throw new ForgeError('The design service is busy. Try again in a minute.', 503)
    if (e instanceof Anthropic.APIError) throw new ForgeError(`The design service failed (${e.status ?? 'network'}).`)
    throw e
  }
}

/**
 * The review pass: Claude looks at renders of the design (at rest and each mode at full drive), lists what it fixed,
 * and returns the corrected design, which goes through the same house-style check as any other.
 */
export async function critiqueGremlin(
  designer: ForgeDesigner,
  req: { spec: unknown; stills: { label: string; image: string }[]; care?: boolean },
  signal?: AbortSignal,
): Promise<{ spec: ForgeSpec; notes: string[]; fixed: string[] }> {
  let current: ForgeSpec
  try { current = checkForgeSpec(req.spec).spec } catch (e) { throw new ForgeError((e as Error).message, 400) }
  const stills = req.stills.slice(0, FORGE_CRITIQUE_MAX_STILLS)
  const images = stills.map((s, i) => decodeImage(s.image, `still ${i + 1}`))
  const text = await ask(designer, forgeCritiquePrompt(current, stills.map((s) => s.label.replace(/[\u0000-\u001f]/g, ' '))), { care: !!req.care, signal, images })
  let reply: { fixed?: unknown; design?: unknown }
  try { reply = parseModelJson(text) as typeof reply } catch (e) { throw new ForgeError((e as Error).message) }
  const fixed = (Array.isArray(reply.fixed) ? reply.fixed : []).slice(0, 12).map((f) => String(f).replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean)
  try {
    const { spec, notes } = checkForgeSpec(reply.design ?? reply)
    return { spec, notes, fixed }
  } catch (e) {
    throw new ForgeError((e as Error).message)
  }
}

/**
 * A film's special instructions: Claude turns the maker's words into a cut (what to feature, in what order, at what
 * pace, in whose words, the closer), checked against the design like any cut. Nothing is filmed here.
 */
export async function cutWithInstructions(
  designer: ForgeDesigner,
  req: { spec: unknown; story?: unknown; cut?: unknown; instructions: string; link?: string },
  signal?: AbortSignal,
): Promise<{ cut: ForgeCut; note: string }> {
  let spec: ForgeSpec
  try { spec = checkForgeSpec(req.spec).spec } catch (e) { throw new ForgeError((e as Error).message, 400) }
  const story = checkStory(req.story, true) ?? spec.story ?? null
  const current = checkForgeCut(req.cut, spec, story)
  // a short reply; one more try if it doesn't come back as JSON
  let reply: { cut?: unknown; note?: unknown } | undefined, lastError: unknown
  for (let i = 0; i < 2 && !reply; i++) {
    const text = await ask(designer, forgeCutPrompt(spec, story, current, req.instructions, req.link), { care: false, signal })
    try { reply = parseModelJson(text) as typeof reply } catch (e) { lastError = e }
  }
  if (!reply) throw new ForgeError((lastError as Error).message)
  return { cut: checkForgeCut(reply.cut ?? reply, spec, story), note: String(reply.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) }
}

// ------------------------------------------------------------------------------------------------ photo (image model)

export interface PhotoProvider {
  name: 'fal' | 'gemini' | 'openai'
  model: string
  /** Repaints the PNG render as a photo; returns the image bytes. */
  render(png: Uint8Array, prompt: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>
}

type Fetch = typeof fetch
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

async function failText(res: Response): Promise<string> {
  const t = await res.text().catch(() => '')
  return `${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`
}

/** fal.ai (default model: FLUX.1 Kontext [pro], an instruction-following image editor). */
export function falProvider(key: string, model = 'fal-ai/flux-pro/kontext', f: Fetch = fetch): PhotoProvider {
  return {
    name: 'fal',
    model,
    async render(png, prompt, signal) {
      const res = await f(`https://fal.run/${model}`, {
        method: 'POST',
        signal,
        headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, image_url: `data:image/png;base64,${b64(png)}`, num_images: 1, output_format: 'png' }),
      })
      if (!res.ok) throw new ForgeError(`fal.ai rejected the render (${await failText(res)}).`)
      const j = (await res.json()) as { images?: { url?: string; content_type?: string }[]; image?: { url?: string } }
      const url = j.images?.[0]?.url ?? j.image?.url
      if (!url) throw new ForgeError('fal.ai returned no image.')
      if (url.startsWith('data:')) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(url)
        if (!m) throw new ForgeError('fal.ai returned an unreadable image.')
        return { bytes: unb64(m[2]!), mime: m[1]! }
      }
      if (!url.startsWith('https://')) throw new ForgeError('fal.ai returned an unexpected image address.')
      const img = await f(url, { signal })
      if (!img.ok) throw new ForgeError(`Could not download the photo from fal.ai (${img.status}).`)
      return { bytes: new Uint8Array(await img.arrayBuffer()), mime: img.headers.get('content-type') ?? 'image/png' }
    },
  }
}

/** Google Gemini image model through the Gemini API (generateContent with an image part in, an image part out). */
export function geminiProvider(key: string, model = 'gemini-2.5-flash-image', f: Fetch = fetch): PhotoProvider {
  return {
    name: 'gemini',
    model,
    async render(png, prompt, signal) {
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal,
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: b64(png) } }, { text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      })
      if (!res.ok) throw new ForgeError(`Gemini rejected the render (${await failText(res)}).`)
      type Part = { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }
      const j = (await res.json()) as { candidates?: { content?: { parts?: Part[] } }[] }
      for (const p of j.candidates?.[0]?.content?.parts ?? []) {
        const d = p.inlineData?.data ?? p.inline_data?.data
        if (d) return { bytes: unb64(d), mime: p.inlineData?.mimeType ?? p.inline_data?.mime_type ?? 'image/png' }
      }
      throw new ForgeError('Gemini returned no image.')
    },
  }
}

/** OpenAI image edits endpoint (GPT Image models always return base64). */
export function openaiProvider(key: string, model = 'gpt-image-1', f: Fetch = fetch, inputFidelity: string | undefined = 'high'): PhotoProvider {
  return {
    name: 'openai',
    model,
    async render(png, prompt, signal) {
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', prompt)
      form.set('size', '1024x1024')
      form.set('quality', 'high')
      if (inputFidelity) form.set('input_fidelity', inputFidelity)
      form.set('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'render.png')
      const res = await f('https://api.openai.com/v1/images/edits', { method: 'POST', signal, headers: { authorization: `Bearer ${key}` }, body: form })
      if (!res.ok) throw new ForgeError(`OpenAI rejected the render (${await failText(res)}).`)
      const j = (await res.json()) as { data?: { b64_json?: string }[] }
      const d = j.data?.[0]?.b64_json
      if (!d) throw new ForgeError('OpenAI returned no image.')
      return { bytes: unb64(d), mime: 'image/png' }
    },
  }
}

/**
 * Picks the photo provider from the environment: FORGE_PHOTO_PROVIDER (fal | gemini | openai) if set, else the first
 * of FAL_KEY, GEMINI_API_KEY, OPENAI_API_KEY that is present. FORGE_PHOTO_MODEL overrides the provider's default model.
 */
export function photoProviderFromEnv(env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch): PhotoProvider | undefined {
  const model = env.FORGE_PHOTO_MODEL || undefined
  const want = env.FORGE_PHOTO_PROVIDER
  const pick = want || (env.FAL_KEY ? 'fal' : env.GEMINI_API_KEY ? 'gemini' : env.OPENAI_API_KEY ? 'openai' : undefined)
  if (pick === 'fal' && env.FAL_KEY) return falProvider(env.FAL_KEY, model, f)
  if (pick === 'gemini' && env.GEMINI_API_KEY) return geminiProvider(env.GEMINI_API_KEY, model, f)
  if (pick === 'openai' && env.OPENAI_API_KEY) return openaiProvider(env.OPENAI_API_KEY, model, f, env.FORGE_OPENAI_INPUT_FIDELITY ?? 'high')
  if (want) throw new Error(`FORGE_PHOTO_PROVIDER=${want} but its API key is not set`)
  return undefined
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const FORGE_PHOTO_MAX_BYTES = 4 * 1024 * 1024

/** Decodes the browser's `data:image/png;base64,…` render and checks it really is a PNG of a sane size. */
const IMAGE_MAGIC: Record<ForgeImage['mime'], (b: Uint8Array) => boolean> = {
  'image/png': (b) => PNG_MAGIC.every((v, i) => b[i] === v),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
}
/** A picture for Claude, from a PNG, JPEG or WebP data URL; checks the bytes really are that format. */
export function decodeImage(dataUrl: string, what: string): ForgeImage {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) throw new ForgeError(`The ${what} must be a PNG, JPEG or WebP picture.`, 400)
  const mime = m[1] as ForgeImage['mime'], bytes = unb64(m[2]!)
  if (bytes.length > FORGE_PHOTO_MAX_BYTES) throw new ForgeError(`The ${what} is too large (4 MB at most).`, 400)
  if (bytes.length < 64 || !IMAGE_MAGIC[mime](bytes)) throw new ForgeError(`The ${what} isn't a readable ${mime.slice(6).toUpperCase()}.`, 400)
  return { mime, data: m[2]! }
}

export function decodeRender(dataUrl: string): Uint8Array {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) throw new ForgeError('The render must be a PNG data URL.', 400)
  const bytes = unb64(m[1]!)
  if (bytes.length > FORGE_PHOTO_MAX_BYTES) throw new ForgeError('The render is too large.', 400)
  if (bytes.length < 64 || PNG_MAGIC.some((v, i) => bytes[i] !== v)) throw new ForgeError('The render is not a PNG.', 400)
  return bytes
}

export async function photograph(provider: PhotoProvider, dataUrl: string, signal?: AbortSignal): Promise<{ image: string; provider: string; model: string }> {
  const png = decodeRender(dataUrl)
  let out: { bytes: Uint8Array; mime: string }
  try {
    out = await provider.render(png, FORGE_PHOTO_PROMPT, signal)
  } catch (e) {
    if (e instanceof ForgeError) throw e
    throw new ForgeError(`The photo service could not be reached (${(e as Error).message}).`)
  }
  const mime = /^image\/(png|jpeg|webp)$/.test(out.mime) ? out.mime : 'image/png'
  return { image: `data:${mime};base64,${b64(out.bytes)}`, provider: provider.name, model: provider.model }
}
