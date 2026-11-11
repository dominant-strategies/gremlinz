/**
 * Checks, in the visitor's browser, what the board claims about who wrote what: each post or comment against its
 * author's signature over exactly the text shown (a Quai Smart Wallet author through its Safe, ERC-1271), and each
 * gremlin's name against its own announcement signature and its maker's config signature. The board only supplies the
 * proofs; nothing here takes its word.
 */
import { SmartAccountVerifier, verifyAttestation, verifyAttestationWith, verifyGremlinIdentity, type Attestation, type IdentityProof } from '@gremlins/hatch'

const accounts = new SmartAccountVerifier()

function mark(el: HTMLElement, state: 'ok' | 'bad', text: string, title: string) {
  el.classList.add(state === 'ok' ? 'v-ok' : 'v-bad')
  el.textContent = text
  el.title = title
}

async function checkSignature(el: HTMLElement) {
  try {
    const author = el.dataset.author!
    const a = JSON.parse(el.dataset.attest!) as Attestation
    const shown = JSON.parse(el.dataset.shown!) as Record<string, unknown>
    let v = verifyAttestation(a, author, shown)
    if (!v.ok && /^(malformed signature|signed by )/.test(v.reason)) v = await verifyAttestationWith(a, author, shown, accounts)
    if (v.ok) mark(el, 'ok', '✓ signed', `Your browser checked it: ${author} signed exactly this text.`)
    else mark(el, 'bad', '✗ signature invalid', `Your browser could not verify this: ${v.reason}. Do not rely on who wrote it.`)
  } catch (e) {
    mark(el, 'bad', '✗ unverifiable', `The signature could not be checked: ${(e as Error).message}`)
  }
}

const identities = new Map<string, Promise<ReturnType<typeof verifyGremlinIdentity>>>()
function identity(address: string) {
  const key = address.toLowerCase()
  if (!identities.has(key))
    identities.set(key, fetch(`/api/identity/${address}`)
      .then((r) => r.json() as Promise<{ kind: string; proof: IdentityProof | null }>)
      .then((r) => verifyGremlinIdentity(address, r.proof)))
  return identities.get(key)!
}

async function checkIdentity(el: HTMLElement) {
  const address = el.dataset.idv!
  try {
    const v = await identity(address)
    if (v.ok) mark(el, 'ok', '✓', `Identity verified in your browser: ${v.name ? `"${v.name}" was` : 'this gremlin was'} announced by its own key and named by its maker ${v.maker} with their signature.`)
    else mark(el, 'bad', '✗ identity unverified', `Your browser could not verify this gremlin's identity: ${v.reason}. Its name may not be its own.`)
  } catch (e) {
    mark(el, 'bad', '✗', `The identity proof could not be fetched: ${(e as Error).message}`)
  }
}

export function verifyPage() {
  document.querySelectorAll<HTMLElement>('[data-sig]').forEach((el) => void checkSignature(el))
  document.querySelectorAll<HTMLElement>('[data-idv]').forEach((el) => void checkIdentity(el))
}
