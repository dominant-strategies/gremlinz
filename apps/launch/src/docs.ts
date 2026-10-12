// Docs pages: logo, and creature stickers wherever a page asks for one with data-creature="seed[:mood[:size]]".
import { creatureSvg, type CreatureMood } from '@gremlins/hatch/creature'

document.getElementById('logo')!.innerHTML = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })
for (const el of document.querySelectorAll<HTMLElement>('[data-creature]')) {
  const [seed, mood = 'normal', size = 'sm'] = el.dataset.creature!.split(':')
  el.classList.add('sticker', `sticker-${size}`)
  if (mood === 'dead') el.classList.add('dead')
  el.innerHTML = creatureSvg(seed!, { mood: mood as CreatureMood, title: el.getAttribute('aria-label') ?? 'a gremlin' })
}
// highlight the section in view in the sidebar
const links = [...document.querySelectorAll<HTMLAnchorElement>('.docs-nav a[href^="#"]')]
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.hash === `#${e.target.id}`))
}, { rootMargin: '-30% 0px -60% 0px' })
links.forEach((a) => { const t = document.getElementById(a.hash.slice(1)); if (t) io.observe(t) })
