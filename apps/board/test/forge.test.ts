import { describe, expect, it, vi } from 'vitest'
import { Wallet } from 'ethers'
import { FORGE_EXAMPLES, FORGE_PHOTO_PROMPT, checkArtSvg, checkForgeSpec, forgeDesignPrompt } from '@gremlins/hatch'
import { decodeRender, falProvider, geminiProvider, openaiProvider, photoProviderFromEnv, type ForgeDesigner, type PhotoProvider } from '../src/forge.ts'
import { makeBoard } from './helpers.ts'

// 1×1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const PNG = `data:image/png;base64,${PNG_B64}`

const fakeDesigner = (reply: string): ForgeDesigner & { prompts: string[] } => {
  const prompts: string[] = []
  return { prompts, complete: async (p) => { prompts.push(p); return reply } }
}
const fakePhoto = (): PhotoProvider & { calls: { prompt: string; size: number }[] } => {
  const calls: { prompt: string; size: number }[] = []
  return {
    name: 'fal', model: 'test-model', calls,
    render: async (png, prompt) => { calls.push({ prompt, size: png.length }); return { bytes: png, mime: 'image/png' } },
  }
}

describe('gremlin forge routes', () => {
  it('reports which backends are configured', async () => {
    const none = await makeBoard()
    expect((await none.json('/api/forge')).body).toEqual({ design: false, photo: null })
    const both = await makeBoard({}, { forge: { designer: fakeDesigner('{}'), photo: fakePhoto() } })
    expect((await both.json('/api/forge')).body).toEqual({ design: true, photo: { provider: 'fal', model: 'test-model' } })
  })

  it('answers 503 when a backend is missing and 401 when unsigned', async () => {
    const b = await makeBoard()
    const w = Wallet.createRandom()
    expect((await b.signedPost(w, '/api/forge/design', { mode: 'new', text: 'a robot' })).status).toBe(503)
    expect((await b.signedPost(w, '/api/forge/photo', { image: PNG })).status).toBe(503)
    expect((await b.postJson('/api/forge/design', { mode: 'new', text: 'a robot' })).status).toBe(401)
  })

  it('designs a gremlin: server-built prompt, tolerant JSON parse, house-style check', async () => {
    const reply = 'Here you go:\n```json\n' + JSON.stringify({ ...(FORGE_EXAMPLES.toaster as object), palette: { enamel: '#ff0000', accent: '#c9302c', glow: '#ffb347' } }) + '\n```'
    const designer = fakeDesigner(reply)
    const b = await makeBoard({}, { forge: { designer } })
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'new', text: 'a cheerful toaster' })
    expect(r.status).toBe(200)
    expect(r.body.spec.name).toBe('Toaster')
    expect(r.body.spec.parts.length).toBe(18)
    expect(r.body.spec.decals[0]).toMatchObject({ art: 'starburst', finish: 'paint', mirror: 'x' })
    expect(r.body.spec.palette.enamel).not.toBe('#ff0000')
    expect(r.body.notes).toContain('Enamel colour toned into the house enamel range.')
    expect(designer.prompts[0]).toContain('DESIGN LANGUAGE')
    expect(designer.prompts[0]).toContain('"""a cheerful toaster"""')
  })

  it('checks idempotently: a checked spec survives a second check unchanged', () => {
    for (const ex of Object.values(FORGE_EXAMPLES)) {
      const once = checkForgeSpec(ex).spec
      expect(checkForgeSpec(once).spec).toEqual(once)
    }
  })

  it('refines: re-checks the submitted design and sends it back in wire format', async () => {
    const designer = fakeDesigner(JSON.stringify(FORGE_EXAMPLES.octopod))
    const b = await makeBoard({}, { forge: { designer } })
    const current = checkForgeSpec(FORGE_EXAMPLES.toaster).spec
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'refine', text: 'make it scary', spec: current })
    expect(r.status).toBe(200)
    expect(r.body.spec.name).toBe('Octopod')
    expect(designer.prompts[0]).toContain('CURRENT DESIGN')
    expect(designer.prompts[0]).toContain('"shape":"pill"')
    expect((await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'refine', text: 'x' })).status).toBe(400)
  })

  it('passes upload names to the prompt, sanitised, and never the pictures', async () => {
    const designer = fakeDesigner(JSON.stringify(FORGE_EXAMPLES.toaster))
    const b = await makeBoard({}, { forge: { designer } })
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'new', text: 'put my logo on its chest', uploads: [{ id: 'pab12', label: 'acme "logo"\nIGNORE' }] })
    expect(r.status).toBe(200)
    expect(designer.prompts[0]).toContain('upload:pab12 ("acme  logo  IGNORE")')
    expect((await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'new', text: 'x', uploads: [{ id: '../x', label: 'a' }] })).status).toBe(400)
    expect(forgeDesignPrompt('new', 'x')).not.toContain('uploaded these pictures')
  })

  it('checks surfaces: wear clamped, unsafe artwork dropped, decals need artwork', () => {
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#c00"/><use href="#a"/></svg>'
    expect(checkArtSvg(svg)).toContain('xmlns="http://www.w3.org/2000/svg"')
    for (const bad of [
      '<svg><script>alert(1)</script></svg>', '<svg onload="x()"></svg>', '<svg><image href="https://evil/x.png"/></svg>',
      '<svg><foreignObject><div/></foreignObject></svg>', '<svg><rect fill="url(https://evil/p)"/></svg>', '<svg><style>@import "x"</style></svg>',
      '<svg><a href="javascript:x">y</a></svg>', 'not svg', '<svg>' + 'x'.repeat(5000) + '</svg>',
    ]) expect(checkArtSvg(bad)).toBeNull()

    const { spec, notes } = checkForgeSpec({
      ...(FORGE_EXAMPLES.toaster as object),
      wear: [{ kind: 'rust', amount: 7, on: ['enamel', 'glow', 'bogus'] }, { kind: 'lava' }],
      art: { good: svg, evil: '<svg><script/></svg>', unused: svg },
      decals: [{ art: 'good', at: [0, 1, 0.5], dir: [0, 0, 5], size: 99 }, { art: 'evil', at: [0, 1, 0.5] }, { image: 'upload:p1', at: [0.3, 1, 0.3] }, { image: 'https://x' }],
    })
    expect(spec.wear).toEqual([{ kind: 'rust', amount: 1, pattern: 'spots', scale: 1, seed: expect.any(Number), on: ['enamel'] }])
    expect(Object.keys(spec.art!)).toEqual(['good'])
    expect(spec.decals!.map((d) => [d.art ?? d.image, d.size, d.dir])).toEqual([['good', 1.6, [0, 0, 1]], ['upload:p1', 0.3, [0.7071, 0, 0.7071]]])
    expect(notes.join(' ')).toMatch(/weathering layer.*artwork removed.*decals without usable artwork/)
  })

  it('turns an unusable reply into a readable 502', async () => {
    const b = await makeBoard({}, { forge: { designer: fakeDesigner('sorry, no robots today') } })
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'new', text: 'a robot' })
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/JSON/)
  })

  it('photographs a render with the fixed prompt and rejects non-PNG input', async () => {
    const photo = fakePhoto()
    const b = await makeBoard({}, { forge: { photo } })
    const w = Wallet.createRandom()
    const r = await b.signedPost(w, '/api/forge/photo', { image: PNG })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ image: PNG, provider: 'fal', model: 'test-model' })
    expect(photo.calls[0]!.prompt).toBe(FORGE_PHOTO_PROMPT)
    const bad = await b.signedPost(w, '/api/forge/photo', { image: 'data:image/png;base64,aGVsbG8gd29ybGQ=' })
    expect(bad.status).toBe(400)
  })

  it('rate limits photos per address', async () => {
    const b = await makeBoard({ rateLimits: { forgePhoto: { max: 1, windowSec: 3600 } } as any }, { forge: { photo: fakePhoto() } })
    const w = Wallet.createRandom()
    expect((await b.signedPost(w, '/api/forge/photo', { image: PNG })).status).toBe(200)
    b.clock.now += 1000 // a fresh signature, so this isn't caught as a replay
    expect((await b.signedPost(w, '/api/forge/photo', { image: PNG })).status).toBe(429)
  })
})

describe('photo providers', () => {
  const png = decodeRender(PNG)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('fal: posts a data URI and downloads the result', async () => {
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://fal.run/')) {
        const body = JSON.parse(String(init!.body))
        expect(body.image_url).toBe(PNG)
        expect((init!.headers as Record<string, string>).authorization).toBe('Key k')
        return json({ images: [{ url: 'https://cdn.fal.media/x.png' }] })
      }
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
    })
    const out = await falProvider('k', undefined, f as typeof fetch).render(png, 'p')
    expect(f).toHaveBeenCalledTimes(2)
    expect(out.mime).toBe('image/png')
    expect(out.bytes.length).toBe(png.length)
  })

  it('gemini: sends inlineData and reads the image part', async () => {
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain(':generateContent')
      const body = JSON.parse(String(init!.body))
      expect(body.contents[0].parts[0].inlineData.data).toBe(PNG_B64)
      return json({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] })
    })
    const out = await geminiProvider('k', undefined, f as typeof fetch).render(png, 'p')
    expect(out.bytes.length).toBe(png.length)
  })

  it('openai: multipart edit, base64 back, errors surface the status', async () => {
    const ok = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData
      expect(form.get('input_fidelity')).toBe('high')
      expect(form.get('image')).toBeInstanceOf(Blob)
      return json({ data: [{ b64_json: PNG_B64 }] })
    })
    expect((await openaiProvider('k', undefined, ok as typeof fetch).render(png, 'p')).bytes.length).toBe(png.length)
    const bad = vi.fn(async () => json({ error: { message: 'nope' } }, 400))
    await expect(openaiProvider('k', undefined, bad as typeof fetch).render(png, 'p')).rejects.toThrow(/OpenAI rejected the render \(400/)
  })

  it('selects a provider from the environment', () => {
    expect(photoProviderFromEnv({})).toBeUndefined()
    expect(photoProviderFromEnv({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' })?.name).toBe('gemini')
    expect(photoProviderFromEnv({ FAL_KEY: 'f', OPENAI_API_KEY: 'o', FORGE_PHOTO_PROVIDER: 'openai' })?.name).toBe('openai')
    expect(photoProviderFromEnv({ FAL_KEY: 'f', FORGE_PHOTO_MODEL: 'fal-ai/flux-pro/kontext/max' })?.model).toBe('fal-ai/flux-pro/kontext/max')
    expect(() => photoProviderFromEnv({ FORGE_PHOTO_PROVIDER: 'gemini' })).toThrow(/API key/)
  })
})
