import { hatchUrl, resumeSaved, savedSessions, SESSION_KEY, startOver, type LaunchChannel, type Session } from './session.js'

export function mountLaunchControls(options: {
  current: () => Session
  channel: LaunchChannel
  lookupChannel: (jobId: string) => Promise<LaunchChannel>
  navigate?: (url: string) => void
}) {
  const dialog = document.querySelector<HTMLDialogElement>('#hatch-session-dialog')!
  const content = dialog.querySelector<HTMLElement>('[data-content]')!
  const error = dialog.querySelector<HTMLElement>('[data-error]')!
  const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!
  const navigate = options.navigate ?? (url => window.location.assign(url))
  let busy = false
  const failure = (e: unknown) => { error.textContent = `${e instanceof Error ? e.message : String(e)} Keep this page open and try again.`; error.hidden = false }
  const setBusy = (value: boolean) => {
    busy = value
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value
  }
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault() })
  cancel.onclick = () => dialog.close()
  const open = (title: string) => {
    dialog.querySelector<HTMLElement>('h2')!.textContent = title
    content.replaceChildren()
    error.hidden = true
    if (!dialog.open) dialog.showModal()
  }
  const paragraph = (text: string) => {
    const p = document.createElement('p'); p.textContent = text; content.append(p)
  }
  const channelOf = async (session: Session, fallback?: LaunchChannel) => {
    if (session.hatch) {
      try { return await options.lookupChannel(session.hatch.jobId) } catch { return session.channel ?? fallback }
    }
    return session.channel ?? fallback ?? options.channel
  }
  const perform = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch (e) { failure(e); setBusy(false) }
  }

  function showStartOver() {
    open('Start over?')
    paragraph('Your current hatch will be saved in this browser. You can return to it from Saved hatches, including its progress and hosting key share.')
    paragraph('Existing payments and rented servers continue separately. Funds from the previous hatch do not move to the new one. Keep this browser’s site data to resume a paid hatch.')
    paragraph(`The new hatch will use ${options.channel === 'canary' ? 'the canary test settings' : 'the current default launch settings'}.`)
    const button = document.createElement('button')
    button.type = 'button'; button.textContent = 'Save hatch and start over'
    button.onclick = () => void perform(async () => {
      const current = options.current()
      const previousChannel = await channelOf(current)
      startOver(current, previousChannel, options.channel)
      // Reload ends old polling/payment callbacks before the fresh session starts.
      navigate(hatchUrl(window.location.href, options.channel))
    })
    content.append(button)
    button.focus()
  }

  function showSaved() {
    open('Saved hatches')
    paragraph('Resume a hatch in this browser. The hatch you are on now will be saved before switching.')
    try {
      const rows = savedSessions().filter(r => r.session.launchId !== options.current().launchId)
      if (!rows.length) paragraph('No earlier hatches have been saved yet.')
      for (const row of rows) {
        const item = document.createElement('div'); item.className = 'saved-hatch'
        const label = document.createElement('p')
        label.textContent = `${row.session.config?.name || row.session.draft?.name || 'Unnamed gremlin'} · ${row.channel === 'canary' ? 'canary' : row.channel === 'stable' ? 'default' : 'settings checked on resume'} · ${row.session.launchId.slice(0, 8)}`
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'secondary'; button.textContent = 'Resume'
        button.onclick = () => void perform(async () => {
          const channel = await channelOf(row.session, row.channel)
          if (!channel) throw new Error('Could not check the saved hatch’s launch channel. Check your connection and try again.')
          const current = options.current()
          resumeSaved(row.session.launchId, current, await channelOf(current), channel)
          navigate(hatchUrl(window.location.href, channel))
        })
        item.append(label, button); content.append(item)
      }
    } catch (e) { failure(e) }
  }

  document.querySelector<HTMLButtonElement>('#hatch-start-over')!.onclick = showStartOver
  document.querySelector<HTMLButtonElement>('#hatch-saved')!.onclick = showSaved
  // Other tabs stop their old loops when this browser selects another active hatch.
  window.addEventListener('storage', e => {
    if (e.key !== SESSION_KEY) return
    try { if (JSON.parse(e.newValue ?? 'null')?.launchId === options.current().launchId) return } catch { /* pause */ }
    const url = new URL(window.location.href)
    url.searchParams.set('hatch-paused', '1')
    navigate(url.toString())
  })
  return { showStartOver }
}
