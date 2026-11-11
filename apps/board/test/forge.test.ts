import { describe, expect, it, vi } from 'vitest'
import { Wallet, type HDNodeWallet } from 'ethers'
type AnyWallet = Wallet | HDNodeWallet
import { AUTH_HEADERS, FORGE_EXAMPLES, FORGE_PHOTO_PROMPT, SESSION_HEADER, checkArtSvg, checkForgeSpec, forgeDesignPrompt, sessionGrantMessage, signRequest } from '@gremlins/hatch'
import { decodeImage, decodeRender, falProvider, geminiProvider, openaiProvider, photoProviderFromEnv, type ForgeDesigner, type PhotoProvider } from '../src/forge.ts'
import { hatch, makeBoard } from './helpers.ts'

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

describe('forge session keys: sign once, then build without wallet prompts', () => {
  const path = '/api/forge/design'
  const body = JSON.stringify({ mode: 'new', text: 'a cheerful toaster' })
  /** A grant from `user` to `key`, and a request signed by `signer` (the key, unless a test swaps it). */
  async function send(b: Awaited<ReturnType<typeof makeBoard>>, o: { user?: AnyWallet; key?: AnyWallet; signer?: AnyWallet; grantBy?: AnyWallet; to?: string; expiresIn?: number; scope?: string; text?: string } = {}) {
    const user = o.user ?? Wallet.createRandom(), key = o.key ?? Wallet.createRandom(), now = Math.floor(b.clock.now / 1000)
    const terms = { address: user.address.toLowerCase(), key: key.address.toLowerCase(), scope: (o.scope ?? 'forge') as 'forge', expires: now + (o.expiresIn ?? 3600) }
    const grant = { ...terms, signature: await (o.grantBy ?? user).signMessage(sessionGrantMessage(terms)) }
    const text = o.text ?? body, to = o.to ?? path
    const h = await signRequest(o.signer ?? key, 'POST', to, text, now)
    const headers = { 'content-type': 'application/json', ...h, [AUTH_HEADERS.address]: user.address, [SESSION_HEADER]: JSON.stringify(grant) }
    const r = await b.app.request(to, { method: 'POST', headers, body: text })
    return { status: r.status, body: (await r.json()) as any, headers, text, user }
  }
  const board = () => makeBoard({}, { forge: { designer: fakeDesigner(JSON.stringify(FORGE_EXAMPLES.toaster)) } })

  it('designs with a request signed by the session key the wallet granted', async () => {
    const b = await board()
    const r = await send(b)
    expect(r.status).toBe(200)
    expect(r.body.spec.name).toBe('Toaster')
    // the same signed request again is a replay
    const again = await b.app.request(path, { method: 'POST', headers: r.headers, body: r.text })
    expect(again.status).toBe(401)
  })

  it('counts session requests against the granting account for rate limits', async () => {
    const b = await makeBoard({ rateLimits: { forgeDesign: { max: 1, windowSec: 3600 } } as any }, { forge: { designer: fakeDesigner(JSON.stringify(FORGE_EXAMPLES.toaster)) } })
    const user = Wallet.createRandom()
    expect((await send(b, { user })).status).toBe(200)
    expect((await send(b, { user })).status).toBe(429) // a fresh session key doesn't reset the limit
  })

  it('turns down sessions that are expired, too long, granted by someone else, or used by another key', async () => {
    const b = await board()
    expect((await send(b, { expiresIn: -5 })).body.error).toBe('session expired')
    expect((await send(b, { expiresIn: 3 * 24 * 3600 })).body.error).toBe('session too long')
    expect((await send(b, { grantBy: Wallet.createRandom() })).body.error).toBe('session not signed by account')
    expect((await send(b, { signer: Wallet.createRandom() })).body.error).toBe('signature does not match address')
    expect((await send(b, { scope: 'board' })).body.error).toBe('malformed session')
  })

  it('never lets a session key post, vote or do anything outside the Forge', async () => {
    const b = await board()
    const r = await send(b, { to: '/api/c/general/posts', text: JSON.stringify({ title: 'not me' }) })
    expect(r.status).toBe(401)
    expect(r.body.error).toMatch(/only work in the Forge/)
  })
})

describe('forge reference pictures and the review pass', () => {
  const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(80).fill(0)]).toString('base64')}`
  /** A designer that records the pictures it was shown. */
  const seeing = (reply: string) => {
    const calls: { prompt: string; images: { mime: string }[] }[] = []
    const d: ForgeDesigner = { complete: async (prompt, o) => { calls.push({ prompt, images: o.images ?? [] }); return reply } }
    return Object.assign(d, { calls })
  }

  it('reads PNG, JPEG and WebP pictures and refuses anything that only claims to be one', () => {
    expect(decodeImage(PNG, 'x').mime).toBe('image/png')
    expect(decodeImage(JPEG, 'x').mime).toBe('image/jpeg')
    expect(() => decodeImage(`data:image/jpeg;base64,${PNG_B64}`, 'reference picture')).toThrow(/isn't a readable JPEG/)
    expect(() => decodeImage('data:image/gif;base64,R0lGOD', 'reference picture')).toThrow(/PNG, JPEG or WebP/)
  })

  it('designs from a reference picture: Claude sees it and the prompt says to rebuild it', async () => {
    const designer = seeing(JSON.stringify(FORGE_EXAMPLES.octopod))
    const b = await makeBoard({}, { forge: { designer } })
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'new', text: 'make it a gremlin', reference: JPEG })
    expect(r.status).toBe(200)
    expect(designer.calls[0]!.images).toEqual([{ mime: 'image/jpeg', data: JPEG.split(',')[1] }])
    expect(designer.calls[0]!.prompt).toContain('REFERENCE PICTURE')
    // without a picture the prompt doesn't mention one
    await b.signedPost(Wallet.createRandom(), '/api/forge/design', { mode: 'new', text: 'a toaster' })
    expect(designer.calls[1]!.prompt).not.toContain('REFERENCE PICTURE')
    expect(designer.calls[1]!.images).toEqual([])
  })

  it('reviews stills and returns the fixed design with what changed', async () => {
    const fixedDesign = { ...(FORGE_EXAMPLES.octopod as object), name: 'Octopod' }
    const designer = seeing('```json\n' + JSON.stringify({ fixed: ['The jaw slid into the mantle; its range is now 0.1.'], design: fixedDesign }) + '\n```')
    const b = await makeBoard({}, { forge: { designer } })
    const stills = [{ label: 'At rest', image: PNG }, { label: 'Strike at full drive', image: JPEG }]
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/critique', { spec: FORGE_EXAMPLES.octopod, stills })
    expect(r.status).toBe(200)
    expect(r.body.fixed).toEqual(['The jaw slid into the mantle; its range is now 0.1.'])
    expect(r.body.spec.assemblies.length).toBe(5)
    expect(designer.calls[0]!.images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg'])
    expect(designer.calls[0]!.prompt).toContain('1. At rest; 2. Strike at full drive')
  })

  it('turns down a review with no stills or an unreadable one', async () => {
    const b = await makeBoard({}, { forge: { designer: seeing('{}') } })
    expect((await b.signedPost(Wallet.createRandom(), '/api/forge/critique', { spec: FORGE_EXAMPLES.octopod, stills: [] })).status).toBe(400)
    const bad = await b.signedPost(Wallet.createRandom(), '/api/forge/critique', { spec: FORGE_EXAMPLES.octopod, stills: [{ label: 'At rest', image: 'data:image/png;base64,AAAA' }] })
    expect(bad.status).toBe(400)
  })
})

describe('forge designs on gremlins (live pages and share cards)', () => {
  const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]).toString('base64')}`

  it('lets the maker put a design and a card on their gremlin, and shows both on its page', async () => {
    const b = await makeBoard()
    const { egg, maker } = await hatch(b, { name: 'Octo' })
    const r = await b.signedPost(maker, `/api/gremlins/${egg.address}/design`, { spec: FORGE_EXAMPLES.octopod, card: JPEG })
    expect(r.status).toBe(200)
    const d = await b.json(`/api/gremlins/${egg.address}/design`)
    expect(d.status).toBe(200)
    expect(d.body.spec.assemblies.length).toBe(5)
    expect(d.body.card).toBe(true)
    const card = await b.req(`/g/${egg.address}/card`)
    expect(card.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await card.arrayBuffer())[0]).toBe(0xff)
    const page = await (await b.req(`/g/${egg.address}`)).text()
    expect(page).toContain(`<iframe src="/forge/?gremlin=${egg.address}"`)
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(page).toMatch(new RegExp(`og:image" content="http://localhost/g/${egg.address}/card\\?v=\\d+"`))
    expect(page).toContain('Eight arms, all of them busy.')
  })

  it('keeps everyone but the maker out, and checks the design', async () => {
    const b = await makeBoard()
    const { egg, maker } = await hatch(b)
    expect((await b.signedPost(Wallet.createRandom(), `/api/gremlins/${egg.address}/design`, { spec: FORGE_EXAMPLES.toaster })).status).toBe(403)
    expect((await b.signedPost(maker, `/api/gremlins/${egg.address}/design`, { spec: { parts: [] } })).status).toBe(400)
    expect((await b.signedPost(maker, `/api/gremlins/${egg.address}/design`, { spec: FORGE_EXAMPLES.toaster, card: 'data:image/png;base64,AAAA' })).status).toBe(400)
    expect((await b.json(`/api/gremlins/${egg.address}/design`)).status).toBe(404)
    // without a design the page has no console and a plain card
    const page = await (await b.req(`/g/${egg.address}`)).text()
    expect(page).not.toContain('<iframe')
    expect(page).toContain('<meta name="twitter:card" content="summary">')
  })

  it("lists a maker's eggs for the Forge to offer", async () => {
    const b = await makeBoard()
    const { egg, maker } = await hatch(b)
    await hatch(b)
    const r = await b.json(`/api/eggs?maker=${maker.address}`)
    expect(r.body.eggs.map((e: { address: string }) => e.address.toLowerCase())).toEqual([egg.address.toLowerCase()])
  })
})

describe('special instructions for a film', () => {
  it('Claude turns them into a cut, checked against the design', async () => {
    const reply = JSON.stringify({
      cut: {
        order: ['exploded', 'modes', 'bogus'], modes: ['vent', 'nope'], spotlight: ['jaw'], pace: 3, motive: false,
        text: { 'mode:vent': { title: 'Breathe out', caption: 'It vents the heat of a thousand trades. <script>' }, 'mode:ghost': { title: 'x' } },
        closer: { headline: 'Meet it', url: 'javascript:alert(1)' },
      },
      note: 'Slower open, vent first. I could not add music.',
    })
    const designer = fakeDesigner(reply)
    const b = await makeBoard({}, { forge: { designer } })
    const r = await b.signedPost(Wallet.createRandom(), '/api/forge/cut', { spec: FORGE_EXAMPLES.octopod, cut: { modes: ['strike'] }, instructions: 'Open on the exploded view, only vent, make it punchy, no music.' })
    expect(r.status).toBe(200)
    expect(r.body.cut).toEqual({
      order: ['exploded', 'modes', 'goals', 'spotlights', 'motive'], modes: ['vent'], spotlight: ['jaw'], pace: 1.6, motive: false,
      text: { 'mode:vent': { title: 'Breathe out', caption: 'It vents the heat of a thousand trades. script' } },
    })
    expect(r.body.note).toMatch(/could not add music/)
    // the prompt carries the maker's words fenced off, the design's own ids, and the cut as it was
    expect(designer.prompts[0]).toContain('<<<INSTRUCTIONS\nOpen on the exploded view')
    expect(designer.prompts[0]).toContain('- vent: ')
    expect(designer.prompts[0]).toContain('{"modes":["strike"]}')
  })
  it('needs instructions, and the design service', async () => {
    const b = await makeBoard({}, { forge: { designer: fakeDesigner('{}') } })
    expect((await b.signedPost(Wallet.createRandom(), '/api/forge/cut', { spec: FORGE_EXAMPLES.octopod, instructions: ' ' })).status).toBe(400)
    const none = await makeBoard()
    expect((await none.signedPost(Wallet.createRandom(), '/api/forge/cut', { spec: FORGE_EXAMPLES.octopod, instructions: 'x' })).status).toBe(503)
  })
})
