/**
 * Gremlin Forge backends: Claude designs the 3D body, an image model turns the studio render into a photo.
 * Both are optional; each is enabled by its API key in the environment and reported by GET /api/forge.
 */
import Anthropic from '@anthropic-ai/sdk'
import { FORGE_PHOTO_PROMPT, checkForgeSpec, forgeDesignPrompt, parseModelJson, type ForgeSpec } from '@gremlins/hatch'

export class ForgeError extends Error {
  readonly status: 400 | 502 | 503
  constructor(message: string, status: 400 | 502 | 503 = 502) {
    super(message)
    this.status = status
  }
}

// ------------------------------------------------------------------------------------------------ design (Claude)

export interface ForgeDesigner {
  /** Returns the model's raw reply text for a prompt built by `forgeDesignPrompt`. */
  complete(prompt: string, opts: { care: boolean; signal?: AbortSignal }): Promise<string>
}

export const FORGE_MODEL = 'claude-opus-5-5'

/** Claude through the official SDK. Credentials resolve the SDK's usual way (ANTHROPIC_API_KEY, etc.). */
export function claudeDesigner(client = new Anthropic()): ForgeDesigner {
  return {
    async complete(prompt, { care, signal }) {
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
            messages: [{ role: 'user', content: prompt }],
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
  req: { mode: 'new' | 'refine'; text: string; spec?: unknown; care?: boolean; uploads?: { id: string; label: string }[] },
  signal?: AbortSignal,
): Promise<{ spec: ForgeSpec; notes: string[] }> {
  let current: ForgeSpec | undefined
  if (req.mode === 'refine') {
    if (!req.spec) throw new ForgeError('A change needs the current design.', 400)
    current = checkForgeSpec(req.spec).spec
  }
  let text: string
  try {
    text = await designer.complete(forgeDesignPrompt(req.mode, req.text, current, req.uploads), { care: !!req.care, signal })
  } catch (e) {
    if (e instanceof ForgeError) throw e
    if (e instanceof Anthropic.RateLimitError) throw new ForgeError('The design service is busy. Try again in a minute.', 503)
    if (e instanceof Anthropic.APIError) throw new ForgeError(`The design service failed (${e.status ?? 'network'}).`)
    throw e
  }
  try {
    return checkForgeSpec(parseModelJson(text))
  } catch (e) {
    throw new ForgeError((e as Error).message)
  }
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
