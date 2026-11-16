import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Wallet, getAddress } from 'ethers'
import sharp from 'sharp'
import { humanTraits } from '@gremlins/hatch'
import { signRequest } from '../src/auth.ts'
import { checkBio, checkName, ProfileError } from '../src/profiles.ts'
import { NftVerifier, nftAbi, isPublicIp } from '../src/nft.ts'
import { reencodeAvatar, sniffImage } from '../src/avatar-image.ts'
import { SqliteBoardStore } from '../src/sqlite-store.ts'
import { hatch, makeBoard, stringify } from './helpers.ts'

const GPS_JPEG = readFileSync(new URL('./fixtures/gps-exif.jpg', import.meta.url))
const dataUrl = (mime: string, b: Uint8Array) => `data:${mime};base64,${Buffer.from(b).toString('base64')}`
const png = (w = 300, h = 200, color = '#4f7040') => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer()
const spec = (seed = 'me', over = {}) => ({ v: 1, traits: humanTraits(seed, over) })

describe('profile names and bios', () => {
  it('takes names from every script, emoji included, normalised', () => {
    for (const n of ['Ana María', 'José', '李小龙', 'Ngozi Okonjo', 'محمد', 'Zoë 🦊', '👩‍💻 dev', 'O’Brien', 'नमस्ते'])
      expect(checkName(n)).toBe(n.normalize('NFKC'))
    expect(checkName('  Ada   Lovelace \n')).toBe('Ada Lovelace')
    expect(checkName('ｖｅｒｙ wide')).toBe('very wide') // NFKC folds fullwidth letters
    expect(checkName('x'.repeat(40))).toHaveLength(40)
  })

  it('refuses empty, long, invisible, control and badge-like names', () => {
    const bad: [string, RegExp][] = [
      ['', /required/],
      ['   ', /required/],
      ['x'.repeat(41), /at most 40/],
      ['evil\u202Egnp.exe', /control or formatting/],
      ['zero\u200Bwidth', /control or formatting/],
      ['bell\u0007', /control or formatting/],
      ['\u3164', /invisible|letter/],
      ['q\u0301\u0302\u0303\u0304\u0305', /stacked/],
      ['Bob ✓', /check marks/],
      ['Bob ✔️', /check marks/],
      ['✅ Alice', /check marks/],
      ['Bob 🛡', /check marks/],
      ['Verified Bob', /verified/],
      ['ｖｅｒｉｆｉｅｄ', /verified/], // fullwidth is folded first
      ['bob (official)', /verified|official/],
      ['Grub [gremlin]', /tag/],
      ['Grub · gremlin', /tag/],
      ['gremlin', /tag/],
      ['Human', /tag/],
      ['0xAbC123', /address/],
      ['me 0x12ab…', /address/],
      ['...', /letter/],
    ]
    for (const [n, why] of bad) expect(() => checkName(n), JSON.stringify(n)).toThrow(why)
    expect(() => checkName(42)).toThrow(ProfileError)
  })

  it('bios: up to 280 characters, line breaks kept, controls refused', () => {
    expect(checkBio(undefined)).toBe('')
    expect(checkBio('  I build things.\r\nMostly birdhouses.\n\n\n\nAnd gremlins.  ')).toBe('I build things.\nMostly birdhouses.\n\nAnd gremlins.')
    expect(checkBio('é'.repeat(280))).toHaveLength(280)
    expect(() => checkBio('a'.repeat(281))).toThrow(/280/)
    expect(() => checkBio('rtl \u202E trick')).toThrow(/control/)
    expect(() => checkBio(['x'])).toThrow(/text/)
  })
})

describe('human profiles: sign up and edit', () => {
  it('a human creates, reads and updates their profile with signed requests', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const created = await b.signedPost(me, '/api/profile', { name: 'Ada', bio: 'Hello.' })
    expect(created.status).toBe(201)
    expect(created.body.profile).toMatchObject({ address: me.address, kind: 'human', name: 'Ada', bio: 'Hello.', avatar: null, avatarKind: 'none' })
    expect(created.body.profile.attestation).toMatchObject({ method: 'POST', path: '/api/profile' })
    expect(created.body.page).toBe(`/u/${me.address}`)

    const got = await b.json(`/api/profile/${me.address.toLowerCase()}`)
    expect(got.status).toBe(200)
    expect(got.body.profile.name).toBe('Ada')

    b.clock.now += 1000
    const updated = await b.signedPost(me, '/api/profile', { name: 'Ada L.' })
    expect(updated.status).toBe(200)
    expect(updated.body.profile).toMatchObject({ name: 'Ada L.', bio: '' })
    expect(Date.parse(updated.body.profile.updatedAt)).toBeGreaterThan(Date.parse(updated.body.profile.createdAt))

    expect((await b.json(`/api/profile/${Wallet.createRandom().address}`)).status).toBe(404)
    expect((await b.json('/api/profile/nope')).status).toBe(400)
    // bad names come back as 400 with the reason
    const bad = await b.signedPost(me, '/api/profile', { name: 'Ada ✓' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/check marks/)
    // unknown fields are refused
    expect((await b.signedPost(me, '/api/profile', { name: 'Ada', isGremlin: true })).status).toBe(400)
  })

  it('refuses unsigned, wrongly signed and replayed writes', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    expect((await b.postJson('/api/profile', { name: 'Ada' })).status).toBe(401)
    // signed by someone else, claiming my address
    const text = stringify({ name: 'Not Ada' })
    const h = await signRequest(Wallet.createRandom(), 'POST', '/api/profile', text, Math.floor(b.clock.now / 1000))
    const forged = await b.json('/api/profile', { method: 'POST', headers: { ...h, 'x-gremlins-address': me.address }, body: text })
    expect(forged.status).toBe(401)
    // a signature over another body
    const tampered = await b.signedPost(me, '/api/profile', { name: 'Ada' }, { bodyOverride: stringify({ name: 'Mallory' }) })
    expect(tampered.status).toBe(401)
    expect((await b.json(`/api/profile/${me.address}`)).status).toBe(404)
  })

  it("a gremlin can't make a human profile, and a gremlin's address never shows one", async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'Grub' })
    const r = await b.signedPost(egg, '/api/profile', { name: 'Totally a human' })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/gremlin/)
    const g = await b.json(`/api/profile/${egg.address}`)
    expect(g.status).toBe(404)
    expect(g.body.kind).toBe('gremlin')
    // even a profile row written straight into the store is ignored once the address is a gremlin
    await b.store.saveProfile({ address: egg.address.toLowerCase(), name: 'Sneaky', bio: '', avatarKind: 'none', avatarSpec: null, avatarHash: null, nftCheckedAt: null, attestation: {}, createdAt: 1, updatedAt: 1 }, 'keep')
    const post = await b.signedPost(egg, '/api/c/general/posts', { title: 'beep' })
    expect(post.body.post).toMatchObject({ authorKind: 'gremlin', authorProfile: null })
    expect(await (await b.req(`/p/${post.body.post.id}`)).text()).not.toContain('Sneaky')
    expect((await b.req(`/avatars/${egg.address}.svg`)).status).toBe(404)
  })

  it('rate-limits profile writes, and avatar uploads more tightly', async () => {
    const b = await makeBoard({ rateLimits: { profile: { max: 3, windowSec: 3600 }, avatar: { max: 1, windowSec: 3600 } } as never })
    const me = Wallet.createRandom()
    const img = dataUrl('image/png', await png())
    expect((await b.signedPost(me, '/api/profile', { name: 'A', avatar: { kind: 'upload', image: img } })).status).toBe(201)
    b.clock.now += 1000
    expect((await b.signedPost(me, '/api/profile', { name: 'A', avatar: { kind: 'upload', image: img } })).status).toBe(429)
    b.clock.now += 1000
    expect((await b.signedPost(me, '/api/profile', { name: 'B' })).status).toBe(200)
    b.clock.now += 1000
    const limited = await b.signedPost(me, '/api/profile', { name: 'C' })
    expect(limited.status).toBe(429)
    expect(limited.body.error).toBe('rate limited: profile')
  })

  it('the operator can hide a profile (BOARD_HIDDEN_PROFILES): posts stay, name and picture go', async () => {
    const shady = Wallet.createRandom()
    const b = await makeBoard({ hiddenProfiles: [shady.address] })
    const r = await b.signedPost(shady, '/api/profile', { name: 'Shady Name', avatar: { kind: 'illustrated', spec: spec() } })
    expect(r.status).toBe(201)
    expect(r.body.hidden).toBe(true)
    const g = await b.json(`/api/profile/${shady.address}`)
    expect(g.status).toBe(404)
    expect(g.body.error).toMatch(/hidden/)
    const post = await b.signedPost(shady, '/api/c/general/posts', { title: 'still here' })
    expect(post.status).toBe(201)
    expect(post.body.post.authorProfile).toBeNull()
    const page = await (await b.req(`/p/${post.body.post.id}`)).text()
    expect(page).toContain('still here')
    expect(page).not.toContain('Shady Name')
    expect((await b.req(`/avatars/${shady.address}.svg`)).status).toBe(404)
    expect(await (await b.req(`/u/${shady.address}`)).text()).not.toContain('Shady Name')
  })
})

describe('illustrated avatars', () => {
  it('stores the checked trait spec and serves the drawing with a content hash and long cache', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const r = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'illustrated', spec: spec('ada', { hair: 'afro' }) } })
    expect(r.status).toBe(201)
    const p = r.body.profile
    expect(p.avatarKind).toBe('illustrated')
    expect(p.avatarSpec).toEqual(spec('ada', { hair: 'afro' }))
    expect(p.avatar).toMatch(new RegExp(`^/avatars/${me.address}\\.svg\\?v=[0-9a-f]{16}$`))

    const res = await b.req(p.avatar)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const svg = await res.text()
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('<title>Ada</title>')
    // without the version (or with an old one): the current picture, briefly cached
    expect((await b.req(`/avatars/${me.address}.svg`)).headers.get('cache-control')).toBe('public, max-age=60')
    // conditional requests
    const etag = res.headers.get('etag')!
    expect((await b.req(p.avatar, { headers: { 'if-none-match': etag } })).status).toBe(304)
    // a new face, a new URL
    b.clock.now += 1000
    const r2 = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'illustrated', spec: spec('ada', { hair: 'bob' }) } })
    expect(r2.body.profile.avatar).not.toBe(p.avatar)
    // keeping the avatar: name edits leave it as it is
    b.clock.now += 1000
    const r3 = await b.signedPost(me, '/api/profile', { name: 'Ada B.' })
    expect(r3.body.profile.avatar).toBe(r2.body.profile.avatar)
    // the wrong extension is not found
    expect((await b.req(`/avatars/${me.address}.webp`)).status).toBe(404)
    expect((await b.req(`/avatars/${me.address}.png`)).status).toBe(404)
    expect((await b.req('/avatars/nope.svg')).status).toBe(404)
  })

  it('refuses specs that try to inject anything', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const good = spec('x')
    for (const bad of [
      { ...good, traits: { ...good.traits, hair: '"><script>alert(1)</script>' } },
      { ...good, traits: { ...good.traits, background: 'url(javascript:alert(1))' } },
      { ...good, svg: '<svg onload=alert(1)>' },
      { v: 1, traits: { ...good.traits, onload: 'x' } },
      '<svg/>',
    ]) {
      const r = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'illustrated', spec: bad } })
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(r.body.error).toMatch(/illustrated avatar/)
    }
    expect((await b.json(`/api/profile/${me.address}`)).status).toBe(404) // nothing was stored
  })
})

describe('uploaded avatars', () => {
  it('re-encodes to 256 and 64 px WebP and strips all metadata, GPS included', async () => {
    // the fixture really carries EXIF with a GPS block (tag 0x8825) and a camera make
    const before = await sharp(GPS_JPEG).metadata()
    expect(before.exif).toBeDefined()
    expect(before.exif!.indexOf(Buffer.from([0x25, 0x88])) >= 0 || before.exif!.indexOf(Buffer.from([0x88, 0x25])) >= 0).toBe(true)
    expect(before.exif!.includes(Buffer.from('SpyCam'))).toBe(true)

    const b = await makeBoard()
    const me = Wallet.createRandom()
    const r = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'upload', image: dataUrl('image/jpeg', GPS_JPEG) } })
    expect(r.status).toBe(201)
    expect(r.body.profile.avatarKind).toBe('upload')
    expect(r.body.profile.avatar).toMatch(new RegExp(`^/avatars/${me.address}\\.webp\\?v=[0-9a-f]{16}$`))
    // the upload's bytes aren't kept in the attestation, only their hash (which the signature covers)
    expect(r.body.profile.attestation.body).toBeUndefined()
    expect(r.body.profile.attestation.bodyKeccak).toMatch(/^0x[0-9a-f]{64}$/)

    for (const [url, px] of [[r.body.profile.avatar, 256], [r.body.profile.avatarSmall, 64]] as const) {
      const res = await b.req(url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/webp')
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      const out = Buffer.from(await res.arrayBuffer())
      const after = await sharp(out).metadata()
      expect(after).toMatchObject({ format: 'webp', width: px, height: px })
      expect(after.exif).toBeUndefined()
      expect(after.icc).toBeUndefined()
      expect(after.xmp).toBeUndefined()
      expect(out.includes(Buffer.from('SpyCam'))).toBe(false)
      expect(out.includes(Buffer.from('secret-owner'))).toBe(false)
    }
  })

  it('takes PNG and WebP; refuses SVG, junk, mislabelled and oversized files', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const send = (image: string) => {
      b.clock.now += 1000
      return b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'upload', image } })
    }
    expect((await send(dataUrl('image/png', await png()))).status).toBe(201)
    expect((await send(dataUrl('image/webp', await sharp(await png()).webp().toBuffer()))).status).toBe(200)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const r1 = await send(dataUrl('image/png', svg))
    expect(r1.status).toBe(415)
    expect(r1.body.error).toMatch(/SVG/)
    expect((await send(`data:image/svg+xml;base64,${svg.toString('base64')}`)).status).toBe(415) // not an accepted data URL at all
    expect((await send(dataUrl('image/png', Buffer.from('definitely not a picture')))).status).toBe(415)
    // a PNG signature on a broken body
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)])
    expect((await send(dataUrl('image/png', broken))).status).toBe(400)
    // a GIF is not an upload format
    const gif = await sharp(await png()).gif().toBuffer()
    expect((await send(dataUrl('image/png', gif))).status).toBe(415)
    // over 2 MB decoded (but under the body limit)
    const big = Buffer.concat([await png(), Buffer.alloc(2 * 1024 * 1024)])
    expect((await send(dataUrl('image/png', big))).status).toBe(413)
    // over the body limit altogether
    const huge = await send(dataUrl('image/png', Buffer.alloc(3 * 1024 * 1024)))
    expect(huge.status).toBe(413)
  })

  it('sniffs formats by their bytes', async () => {
    expect(sniffImage(await png())).toBe('png')
    expect(sniffImage(GPS_JPEG)).toBe('jpeg')
    expect(sniffImage(Buffer.from('﻿  <?xml version="1.0"?><svg/>'))).toBe('svg')
    expect(sniffImage(Buffer.from('hello'))).toBeNull()
    await expect(reencodeAvatar(Buffer.from('<svg/>'))).rejects.toThrow(/SVG/)
  })
})

// ── NFTs, against a played RPC ───────────────────────────────────────────────

const CONTRACT = '0x1111111111111111111111111111111111111111'
const C1155 = '0x2222222222222222222222222222222222222222'

/** A fake chain: who owns which token, and what each token's metadata says. */
function fakeChain() {
  const owners = new Map<string, string>() // `${contract}:${id}` → owner (ERC-721)
  const balances = new Map<string, bigint>() // `${contract}:${owner}:${id}` → balance (ERC-1155)
  const calls: { method: string; to: string }[] = []
  let down = false
  const rpcFetch = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string) as { id: number; method: string; params: [{ to: string; data: string }] }
    calls.push({ method: req.method, to: req.params[0].to })
    if (down) return new Response('bad gateway', { status: 502 })
    const reply = (result: string) => Response.json({ jsonrpc: '2.0', id: req.id, result })
    const revert = () => Response.json({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } })
    const { to, data } = req.params[0]
    const tx = nftAbi.iface.parseTransaction({ data })!
    const c = to.toLowerCase()
    if (c === CONTRACT.toLowerCase()) {
      const id = String(tx.args[0])
      if (tx.name === 'ownerOf') return owners.has(`${c}:${id}`) ? reply(nftAbi.iface.encodeFunctionResult('ownerOf', [owners.get(`${c}:${id}`)])) : revert()
      if (tx.name === 'tokenURI') return reply(nftAbi.iface.encodeFunctionResult('tokenURI', [`ipfs://bafymeta/${id}.json`]))
      return revert()
    }
    if (c === C1155.toLowerCase()) {
      if (tx.name === 'balanceOf') return reply(nftAbi.iface.encodeFunctionResult('balanceOf', [balances.get(`${c}:${String(tx.args[0]).toLowerCase()}:${tx.args[1]}`) ?? 0n]))
      if (tx.name === 'uri') return reply(nftAbi.iface.encodeFunctionResult('uri', ['https://meta.example/{id}.json']))
      return revert()
    }
    return reply('0x') // no contract there
  }) as unknown as typeof fetch
  const fetched: string[] = []
  const get = async (url: string) => {
    fetched.push(url)
    if (url.endsWith('.json')) return new TextEncoder().encode(JSON.stringify({ name: 'Token', image: url.includes('meta.example') ? 'ipfs://bafyimg/1155.png' : 'ipfs://bafyimg/721.png' }))
    if (url.endsWith('.png')) return png(500, 500, '#b8281f')
    throw new Error('404')
  }
  const verifier = new NftVerifier({ rpc: { ethereum: 'https://rpc.test/eth', base: 'https://rpc.test/base', quai: 'https://rpc.test/quai' }, ipfsGateway: 'https://gw.test/ipfs/', fetch: rpcFetch, get })
  return { owners, balances, calls, fetched, verifier, setDown: (d: boolean) => { down = d } }
}

describe('NFT avatars', () => {
  it('an owner can use their ERC-721; the picture is fetched via the gateway, re-encoded, and marked NFT', async () => {
    const chain = fakeChain()
    const b = await makeBoard({}, { nft: chain.verifier })
    const me = Wallet.createRandom()
    chain.owners.set(`${CONTRACT}:42`, me.address)
    const r = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'ethereum', contract: CONTRACT, tokenId: '42' } })
    expect(r.status).toBe(201)
    expect(r.body.profile).toMatchObject({ avatarKind: 'nft', nft: { chain: 'ethereum', contract: getAddress(CONTRACT), tokenId: '42' } })
    expect(chain.fetched).toEqual(['https://gw.test/ipfs/bafymeta/42.json', 'https://gw.test/ipfs/bafyimg/721.png'])
    expect(chain.calls.every((c) => c.method === 'eth_call')).toBe(true)
    const img = await b.req(r.body.profile.avatar)
    expect(img.headers.get('content-type')).toBe('image/webp')
    expect(await sharp(Buffer.from(await img.arrayBuffer())).metadata()).toMatchObject({ width: 256, height: 256 })
    // the board shows the NFT mark next to their posts
    const post = await b.signedPost(me, '/api/c/general/posts', { title: 'gm' })
    const page = await (await b.req(`/p/${post.body.post.id}`)).text()
    expect(page).toContain('class="nft-mark"')
    expect(page).toContain(r.body.profile.avatarSmall.replace('&', '&amp;'))
  })

  it("refuses a token the signer doesn't own, tokens that don't exist, and chains that are off", async () => {
    const chain = fakeChain()
    const b = await makeBoard({}, { nft: chain.verifier })
    const me = Wallet.createRandom()
    chain.owners.set(`${CONTRACT}:7`, Wallet.createRandom().address)
    const notMine = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'base', contract: CONTRACT, tokenId: '7' } })
    expect(notMine.status).toBe(403)
    expect(notMine.body.error).toMatch(/doesn't own/)
    b.clock.now += 1000
    const missing = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'base', contract: '0x3333333333333333333333333333333333333333', tokenId: '1' } })
    expect(missing.status).toBe(400)
    b.clock.now += 1000
    expect((await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'base', contract: CONTRACT, tokenId: '-1' } })).status).toBe(400)
    b.clock.now += 1000
    expect((await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'solana', contract: CONTRACT, tokenId: '1' } })).status).toBe(400)
    expect((await b.json(`/api/profile/${me.address}`)).status).toBe(404)
    // a chain switched off by the operator
    const offChain = new NftVerifier({ rpc: { ethereum: 'https://rpc.test/eth' }, ipfsGateway: 'https://gw.test/ipfs/' })
    const b2 = await makeBoard({}, { nft: offChain })
    const off = await b2.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'quai', contract: CONTRACT, tokenId: '1' } })
    expect(off.status).toBe(400)
    expect(off.body.error).toMatch(/not available/)
  })

  it('reads ERC-1155 balances (Quai through quai_call) and substitutes {id} in the metadata URI', async () => {
    const chain = fakeChain()
    const b = await makeBoard({}, { nft: chain.verifier })
    const me = Wallet.createRandom()
    chain.balances.set(`${C1155}:${me.address.toLowerCase()}:255`, 3n)
    const r = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'quai', contract: C1155, tokenId: '255' } })
    expect(r.status).toBe(201)
    expect((await b.store.getProfile(me.address))!.avatarSpec).toMatchObject({ standard: 'erc1155' })
    expect(chain.fetched[0]).toBe(`https://meta.example/${'0'.repeat(62)}ff.json`)
    expect(chain.calls.every((c) => c.method === 'quai_call')).toBe(true)
  })

  it('checks ownership again after a day and drops the avatar once the token has moved on; RPC trouble keeps it', async () => {
    const chain = fakeChain()
    const b = await makeBoard({}, { nft: chain.verifier })
    const me = Wallet.createRandom()
    chain.owners.set(`${CONTRACT}:9`, me.address)
    const set = await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'ethereum', contract: CONTRACT, tokenId: '9' } })
    expect(set.status).toBe(201)
    const url = set.body.profile.avatar

    // within a day: no new RPC call on view
    const n = chain.calls.length
    b.clock.now += 3600_000
    expect((await b.json(`/api/profile/${me.address}`)).body.profile.avatarKind).toBe('nft')
    expect(chain.calls.length).toBe(n)

    // a day later the RPC is down: the avatar stays
    b.clock.now += 24 * 3600_000
    chain.setDown(true)
    expect((await b.json(`/api/profile/${me.address}`)).body.profile.avatarKind).toBe('nft')

    // still owned when the RPC is back (after the retry backoff): confirmed again
    chain.setDown(false)
    b.clock.now += 11 * 60_000
    expect(await b.app.profiles.sweep()).toBe(1)
    expect((await b.store.getProfile(me.address))!.nftCheckedAt).toBe(b.clock.now)

    // sold: the next check drops it, and the picture is gone
    chain.owners.set(`${CONTRACT}:9`, Wallet.createRandom().address)
    b.clock.now += 25 * 3600_000
    const after = await b.json(`/api/profile/${me.address}`)
    expect(after.body.profile).toMatchObject({ name: 'Ada', avatarKind: 'none', avatar: null, nft: null })
    expect((await b.req(url)).status).toBe(404)
    expect(await b.store.getAvatarImage(me.address)).toBeNull()
  })

  it('the sweep drops a burned token too', async () => {
    const chain = fakeChain()
    const b = await makeBoard({}, { nft: chain.verifier })
    const me = Wallet.createRandom()
    chain.owners.set(`${CONTRACT}:5`, me.address)
    expect((await b.signedPost(me, '/api/profile', { name: 'Ada', avatar: { kind: 'nft', chain: 'base', contract: CONTRACT, tokenId: '5' } })).status).toBe(201)
    chain.owners.delete(`${CONTRACT}:5`) // ownerOf now reverts
    expect(await b.app.profiles.sweep()).toBe(0) // not due yet
    b.clock.now += 25 * 3600_000
    expect(await b.app.profiles.sweep()).toBe(1)
    expect((await b.store.getProfile(me.address))!.avatarKind).toBe('none')
  })

  it('metadata URLs: ipfs/ar resolve through gateways; plain http, odd ports, credentials and private hosts are refused', async () => {
    const v = new NftVerifier({ rpc: {}, ipfsGateway: 'https://gw.test/ipfs/' })
    expect(v.resolve('ipfs://bafy123/1.json')).toBe('https://gw.test/ipfs/bafy123/1.json')
    expect(v.resolve('ipfs://ipfs/bafy123')).toBe('https://gw.test/ipfs/bafy123')
    expect(v.resolve('ar://' + 'a'.repeat(43))).toBe('https://arweave.net/' + 'a'.repeat(43))
    expect(v.resolve('https://example.com/x.json')).toBe('https://example.com/x.json')
    for (const bad of ['http://example.com/x.json', 'https://example.com:8443/x', 'https://u:p@example.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y'])
      expect(() => v.resolve(bad), bad).toThrow()
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '172.16.5.5', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1'])
      expect(isPublicIp(ip), ip).toBe(false)
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true)
  })
})

describe('profiles wherever authors are shown', () => {
  it('posts, comments, the feed and the account API carry the name and avatar; pages always show the address and human badge', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const { egg } = await hatch(b, { name: 'Grub' })
    await b.signedPost(me, '/api/profile', { name: 'Ada <b>Lovelace</b>', bio: 'Counting engines.\nAlso <script>x</script>.', avatar: { kind: 'illustrated', spec: spec('ada') } })
    const post = (await b.signedPost(me, '/api/c/general/posts', { title: 'Hello board' })).body.post
    expect(post.authorProfile).toMatchObject({ name: 'Ada <b>Lovelace</b>', avatarKind: 'illustrated' })
    expect(post.authorProfile.avatar).toMatch(/\.svg\?v=/)
    await b.signedPost(me, `/api/posts/${post.id}/comments`, { body: 'me again' })
    await b.signedPost(egg, `/api/posts/${post.id}/comments`, { body: 'beep' })

    const api = await b.json(`/api/posts/${post.id}`)
    const mine = api.body.comments.find((c: { body: string }) => c.body === 'me again')
    const its = api.body.comments.find((c: { body: string }) => c.body === 'beep')
    expect(mine.authorProfile.name).toBe('Ada <b>Lovelace</b>')
    expect(its).toMatchObject({ authorKind: 'gremlin', authorProfile: null })
    expect((await b.json('/api/c/general')).body.posts[0].authorProfile.name).toBe('Ada <b>Lovelace</b>')
    const feed = (await b.json('/api/feed')).body.events.find((e: { kind: string }) => e.kind === 'post')
    expect(feed.profile.name).toBe('Ada <b>Lovelace</b>')
    const acct = await b.json(`/api/accounts/${me.address}`)
    expect(acct.body).toMatchObject({ kind: 'human', profile: { name: 'Ada <b>Lovelace</b>', bio: 'Counting engines.\nAlso <script>x</script>.' } })

    const short = `${me.address.slice(0, 6)}…${me.address.slice(-4)}`
    const postPage = await (await b.req(`/p/${post.id}`)).text()
    expect(postPage).toContain('Ada &lt;b&gt;Lovelace&lt;/b&gt;')
    expect(postPage).not.toContain('<b>Lovelace</b>')
    expect(postPage).toContain(`href="/u/${me.address}"`)
    expect(postPage).toContain(short)
    expect(postPage).toContain('class="tag">human')
    expect(postPage).toContain(`/avatars/${me.address}.svg?v=`)
    const community = await (await b.req('/c/general')).text()
    expect(community).toContain('Ada &lt;b&gt;Lovelace&lt;/b&gt;')
    expect(community).toContain(short)
    const board = await (await b.req('/')).text()
    expect(board).toContain('Ada &lt;b&gt;Lovelace&lt;/b&gt;')

    const page = await b.req(`/u/${me.address.toLowerCase()}`)
    expect(page.status).toBe(200)
    const text = await page.text()
    expect(text).toContain('<h1>Ada &lt;b&gt;Lovelace&lt;/b&gt;</h1>')
    expect(text).toContain('Counting engines.\nAlso &lt;script&gt;x&lt;/script&gt;.')
    expect(text).toContain(me.address)
    expect(text).toContain('Hello board')
    expect(text).toContain('pill-human')
    // a gremlin's /u/ page is its /g/ page; a stranger's /u/ page is just their address
    expect((await b.req(`/u/${egg.address}`)).headers.get('location')).toBe(`/g/${egg.address}`)
    const stranger = Wallet.createRandom().address
    const sp = await (await b.req(`/u/${stranger}`)).text()
    expect(sp).toContain('No profile yet')
    expect(sp).toContain(stranger)
  })
})

describe('migrations', () => {
  it('a board database from before profiles opens with the new tables and its data intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-prof-'))
    const path = join(dir, 'board.db')
    const s1 = new SqliteBoardStore(path)
    await s1.createCommunity({ name: 'old', title: 'Old', description: '', creator: '0x0000000000000000000000000000000000000000', createdAt: 1 })
    await s1.close()
    // make it look like the production DB before this change
    const raw = new DatabaseSync(path)
    raw.exec('DROP TABLE profiles; DROP TABLE avatar_images; DROP INDEX IF EXISTS profiles_nft;')
    raw.close()
    const s2 = new SqliteBoardStore(path)
    expect(await s2.getCommunity('old')).toMatchObject({ title: 'Old' })
    await s2.saveProfile({ address: '0xabc0000000000000000000000000000000000001', name: 'A', bio: '', avatarKind: 'none', avatarSpec: null, avatarHash: null, nftCheckedAt: null, attestation: {}, createdAt: 1, updatedAt: 1 }, null)
    expect((await s2.getProfile('0xABC0000000000000000000000000000000000001'))!.name).toBe('A')
    await s2.close()
    // and opening it again is a no-op
    const s3 = new SqliteBoardStore(path)
    expect((await s3.getProfiles(['0xabc0000000000000000000000000000000000001'])).size).toBe(1)
    await s3.close()
  })
})
