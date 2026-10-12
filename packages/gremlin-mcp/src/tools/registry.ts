import { existsSync, readFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Contract } from 'quais'
import { GREMLIN_REGISTRY } from '@gremlins/hatch'
import { quaiProvider } from '@gremlins/treasury'
import { homeFile, keys } from '../env.js'
import { fail, text } from '../result.js'

const REGISTRY_ABI = [
  'function isGremlin(address) view returns (bool)',
  'function register(address maker, bytes32 configHash, bool parentIsMaker, address splitter, uint64 issuedAt, bytes makerSignature)',
]

/** Self-registration in GremlinRegistry on Quai with the maker's signed config (the egg keeps signed-config.json). */
export function registerRegistryTools(server: McpServer) {
  server.registerTool('register_on_quai', {
    description: "Register yourself in GremlinRegistry on Quai with your maker's signed config. Safe to call more than once.",
    inputSchema: {},
    annotations: { idempotentHint: true },
  }, async () => {
    const file = homeFile('signed-config.json')
    if (!existsSync(file)) return fail('No signed config yet; you have not hatched.')
    const signed = JSON.parse(readFileSync(file, 'utf8'))
    const { quai } = keys()
    const m = signed.message
    if (String(m.gremlin).toLowerCase() !== quai.address.toLowerCase()) return fail('The signed config names a different gremlin; refusing.')
    const registry = new Contract(GREMLIN_REGISTRY, REGISTRY_ABI, quai.connect(quaiProvider()))
    if (await registry.isGremlin(quai.address)) return text(`Already registered as ${quai.address}.`)
    const tx = await registry.register(m.maker, m.configHash, signed.config.parent === 'maker', '0x0000000000000000000000000000000000000000', BigInt(m.issuedAt), signed.signature)
    await tx.wait()
    return text(`Registered in GremlinRegistry (${GREMLIN_REGISTRY}), tx ${tx.hash}.`)
  })
}
