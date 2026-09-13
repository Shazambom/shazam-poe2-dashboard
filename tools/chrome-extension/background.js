// Service worker: reads POESESSID (cookies permission) and posts it to the
// dashboard that asked. If the user isn't logged in, opens the PoE login page
// and finishes automatically when the cookie appears (cookies.onChanged).

const POE = 'https://www.pathofexile.com'

async function getCookie() {
  const c = await chrome.cookies.get({ url: POE, name: 'POESESSID' })
  return c && c.value ? c.value : null
}

async function postSession(origin, cookie) {
  try {
    const r = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, label: 'browser extension' }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, message: body.detail || `dashboard said HTTP ${r.status}` }
    return { ok: true, message: body.message || 'Trade session connected.' }
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) }
  }
}

async function notifyDashboards(origin, result) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` })
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { cmd: 'connect-result', ...result }).catch?.(() => {})
  }
}

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || m.cmd !== 'connect') return
  ;(async () => {
    const origin = m.origin
    const cookie = await getCookie()
    if (cookie) {
      sendResponse(await postSession(origin, cookie))
      return
    }
    // Not logged in: remember who asked, open the login page, finish on cookie change.
    await chrome.storage.session.set({ pending: { origin, at: Date.now() } })
    await chrome.tabs.create({ url: `${POE}/login` })
    sendResponse({ ok: false, pending: true, message: 'Log in to pathofexile.com in the tab that just opened — the session connects itself afterwards.' })
  })()
  return true   // keep sendResponse alive across the awaits
})

chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed || cookie.name !== 'POESESSID' || !cookie.domain.includes('pathofexile.com')) return
  const { pending } = await chrome.storage.session.get('pending')
  if (!pending || Date.now() - pending.at > 15 * 60 * 1000) return
  await chrome.storage.session.remove('pending')
  const result = await postSession(pending.origin, cookie.value)
  notifyDashboards(pending.origin, result)
})
