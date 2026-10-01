// Simulates (eth_call, no state change) GremlinRegistry.register on Quai mainnet to prove EIP-712 +
// ecrecover work there, using packages/hatch to sign exactly as makers will.
import { readFileSync } from 'node:fs'
import { Wallet, TypedDataEncoder } from 'ethers'
import { Contract, Interface } from 'quais'
import { quaiProvider } from '../packages/treasury/dist/index.js'
import { HATCH_DOMAIN, HATCH_TYPES, configHash } from '../packages/hatch/dist/index.js'

const { registry } = JSON.parse(readFileSync('contracts/deployments/registry-9.json', 'utf8'))
const { abi } = JSON.parse(readFileSync('contracts/artifacts/contracts/GremlinRegistry.sol/GremlinRegistry.json', 'utf8'))
const gremlin = new Wallet(readFileSync('privkey.key', 'utf8').trim()).address // only used as the simulated caller
const p = quaiProvider()
const reg = new Contract(registry, abi, p)
const iface = new Interface(abi)

const maker = Wallet.createRandom()
const config = { version: 1, name: 'probe', persona: 'p', voice: '', goals: ['g'], preferredModels: [], maker: maker.address, parent: 'maker',
  revenueSplit: { kind: 'none' }, mischiefScope: { game: false, board: false, email: false, phone: false, money: false }, constitution: [], createdAt: new Date().toISOString() }
const msg = { maker: maker.address, gremlin, configHash: configHash(config), issuedAt: BigInt(Math.floor(Date.now() / 1000)) }

const onchainDigest = await reg.hatchDigest(msg.maker, msg.gremlin, msg.configHash, msg.issuedAt)
console.log('digest on-chain == off-chain:', onchainDigest === TypedDataEncoder.hash(HATCH_DOMAIN, HATCH_TYPES, msg))

const simulate = async (sig, from) => {
  const data = iface.encodeFunctionData('register', [msg.maker, msg.configHash, true, '0x0000000000000000000000000000000000000000', msg.issuedAt, sig])
  try { await p.call({ to: registry, from, data }); return 'would succeed' }
  catch (e) { const d = e.data ?? e.info?.error?.data; try { return 'reverted: ' + iface.parseError(d).name } catch { return 'reverted: ' + String(e.shortMessage ?? e.message).slice(0, 120) } }
}
console.log('maker-signed register from the named gremlin :', await simulate(await maker.signTypedData(HATCH_DOMAIN, HATCH_TYPES, msg), gremlin))
console.log('same signature from a squatter address        :', await simulate(await maker.signTypedData(HATCH_DOMAIN, HATCH_TYPES, msg), '0x0011111111111111111111111111111111111111'))
console.log('signature from the wrong key                   :', await simulate(await Wallet.createRandom().signTypedData(HATCH_DOMAIN, HATCH_TYPES, msg), gremlin))
