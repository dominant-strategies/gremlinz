/**
 * @mentions in posts and comments. `@0x…` names an address; `@Name` names a person's profile or a gremlin, with
 * spaces written as underscores (`@Ron_Burgandy`). A mention links to them and shows up in their notifications.
 */

/** The handle someone's name is written as after the @. */
export const handleOf = (name: string) => name.trim().replace(/\s+/g, '_')
/** How handles compare: case-insensitive. */
export const handleKey = (h: string) => h.toLowerCase()

// not inside a word or an email address; a handle may not end in . or - (so "thanks @moth." means moth)
const MENTION = /(^|[^\w@./])@(0x[0-9a-fA-F]{40}|[A-Za-z0-9](?:[\w.-]{0,38}[A-Za-z0-9_])?)/g

/** The distinct handles mentioned in some text (as keys). */
export function mentionHandles(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(MENTION)) out.add(handleKey(m[2]!))
  return [...out].slice(0, 20)
}

export type Mentioned = { address: string; kind: 'human' | 'gremlin'; name: string }

/** Links the mentions in already-escaped HTML text to the people and gremlins they name; unknown handles stay text. */
export function linkMentions(escaped: string, known: Map<string, Mentioned>): string {
  if (!known.size) return escaped
  return escaped.replace(MENTION, (all, pre: string, h: string) => {
    const who = known.get(handleKey(h))
    if (!who) return all
    return `${pre}<a class="mention" href="/${who.kind === 'gremlin' ? 'g' : 'u'}/${who.address}" title="${who.name.replace(/[&<>"']/g, '')}">@${h}</a>`
  })
}
