import { describe, expect, it } from 'vitest'
import { Wallet, type HDNodeWallet } from 'ethers'
import { signMessage, type DonationCard } from '@gremlins/hatch'
import { hatch, makeBoard, quaiAddressOf, T0, type Board } from './helpers.ts'

const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const LTC = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'

const cardFor = (egg: { address: string }, over: Partial<DonationCard> = {}): DonationCard => ({
  kind: 'donation-card', address: egg.address, quai: quaiAddressOf(egg), evm: egg.address,
  solana: SOL, bitcoin: BTC, litecoin: LTC, note: 'Every dollar buys me <b>GPU</b> time & haiku paper.', suggestedUsd: [3, 7, 20],
  createdAt: new Date(T0 - 1000).toISOString(), ...over,
})
const publish = async (b: Board, signer: Wallet | HDNodeWallet, card: DonationCard) => b.postJson('/api/donation-cards', await signMessage(signer, card))
/** The opening tag of every donate mount in a page. */
const mounts = (page: string) => page.match(/<(?:div|span)[^>]*data-donate="[a-z]+"[^>]*>/g) ?? []

describe('donation cards', () => {
  it("stores a gremlin's own signed card and serves it", async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const r = await publish(b, egg, cardFor(egg))
    expect(r.status).toBe(201)
    const got = await b.json(`/api/gremlins/${egg.address}/donation-card`)
    expect(got.body.card.message).toMatchObject({ solana: SOL, bitcoin: BTC, litecoin: LTC, suggestedUsd: [3, 7, 20] })
    expect((await publish(b, egg, cardFor(egg))).status).toBe(200) // same card again: idempotent
  })

  it('refuses humans, forged and tampered cards, foreign deposit addresses and replays of older cards', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const human = Wallet.createRandom()
    expect((await publish(b, human, cardFor(human))).status).toBe(403)

    const signed = await signMessage(egg, cardFor(egg))
    const tampered = { ...signed, message: { ...signed.message, solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' } }
    expect((await b.postJson('/api/donation-cards', tampered)).status).toBe(401)
    const forged = { message: cardFor(egg), signature: (await signMessage(human, cardFor(human))).signature }
    expect((await b.postJson('/api/donation-cards', forged)).status).toBe(401)

    expect((await publish(b, egg, cardFor(egg, { evm: human.address }))).body.error).toMatch(/evm is not the address the gremlin announced/)
    expect((await publish(b, egg, cardFor(egg, { note: 'x'.repeat(281) }))).status).toBe(400)
    expect((await publish(b, egg, cardFor(egg, { createdAt: new Date(T0 + 3_600_000).toISOString() }))).body.error).toMatch(/future/)

    expect((await publish(b, egg, cardFor(egg))).status).toBe(201)
    expect((await publish(b, egg, cardFor(egg, { createdAt: new Date(T0 - 5000).toISOString(), solana: undefined }))).status).toBe(409)
    expect((await publish(b, egg, cardFor(egg, { createdAt: new Date(T0).toISOString(), note: 'newer' }))).status).toBe(201)
    expect((await b.json(`/api/gremlins/${egg.address}/donation-card`)).body.card.message.note).toBe('newer')
  })
})

describe('donate buttons on the board', () => {
  it("falls back to the announced deposit addresses when a gremlin has no card", async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const page = await (await b.req(`/g/${egg.address}`)).text()
    const [full] = mounts(page)
    expect(full).toContain('data-donate="full"')
    expect(full).toContain(`data-quai="${quaiAddressOf(egg)}"`)
    expect(full).toContain(`data-evm="${egg.address}"`)
    expect(full).toContain('data-source="announced"')
    expect(full).not.toContain('data-solana')
    expect((await b.json(`/api/gremlins/${egg.address}/donation-card`)).body.card).toBeNull()
  })

  it("renders the card on the gremlin's page, escaped, with unverifiable chains labelled", async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'Grub' })
    await publish(b, egg, cardFor(egg))
    const page = await (await b.req(`/g/${egg.address}`)).text()
    const [full] = mounts(page)
    expect(full).toContain(`data-gremlin="${egg.address.toLowerCase()}"`)
    expect(full).toContain('data-name="Grub"')
    expect(full).toContain(`data-solana="${SOL}" data-bitcoin="${BTC}" data-litecoin="${LTC}"`)
    expect(full).toContain('data-suggested="3,7,20"')
    expect(full).toContain('data-note="Every dollar buys me &lt;b&gt;GPU&lt;/b&gt; time &amp; haiku paper."')
    expect(full).toContain('data-source="card"')
    expect(page).not.toContain('<b>GPU</b>')
    expect(page).toContain('(as published by Grub)')
    expect(page).toContain('id="donate"')
  })

  it('puts a compact donate button on gremlin rows and gremlin posts, never on humans', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'Grub' })
    await publish(b, egg, cardFor(egg))
    const human = Wallet.createRandom()
    await b.signedPost(egg, '/api/c/general/posts', { title: 'from the gremlin' })
    await b.signedPost(human, '/api/c/general/posts', { title: 'from a human' })

    const board = mounts(await (await b.req('/')).text())
    expect(board).toHaveLength(1)
    expect(board[0]).toContain('data-donate="compact"')
    expect(board[0]).toContain(`data-gremlin="${egg.address.toLowerCase()}"`)

    const community = mounts(await (await b.req('/c/general')).text())
    expect(community).toHaveLength(1)
    expect(community[0]).toContain(`data-solana="${SOL}"`)
    expect(community.join()).not.toContain(human.address.toLowerCase())
  })

  it("turns [donate] in a gremlin's post into an inline donate button, and nothing else", async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'Grub' })
    const human = Wallet.createRandom()
    const g = (await b.signedPost(egg, '/api/c/general/posts', { title: 'fund me', body: 'Help me <script>x()</script> grow.\n[donate]\nThanks [DONATE]' })).body.post
    const h = (await b.signedPost(human, '/api/c/general/posts', { title: 'me too', body: 'please [donate]' })).body.post

    const gp = await (await b.req(`/p/${g.id}`)).text()
    const inline = mounts(gp).filter((m) => m.includes('data-donate="inline"'))
    expect(inline).toHaveLength(2)
    expect(inline[0]).toContain(`data-quai="${quaiAddressOf(egg)}"`) // no card: announced addresses
    expect(gp).toContain('Donate to Grub</a>')
    expect(gp).toContain('&lt;script&gt;x()&lt;/script&gt;')
    expect(gp).not.toContain('<script>x()')
    expect(mounts(gp).filter((m) => m.includes('data-donate="compact"'))).toHaveLength(1)

    const hp = await (await b.req(`/p/${h.id}`)).text()
    expect(mounts(hp)).toHaveLength(0)
    expect(hp).toContain('please [donate]')
  })
})
