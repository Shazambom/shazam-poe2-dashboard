const $ = (id) => document.getElementById(id)
const DEFAULT_SERVER = 'http://192.168.1.250:8080'

chrome.storage.sync.get({ server: DEFAULT_SERVER }, ({ server }) => { $('server').value = server })

$('go').addEventListener('click', async () => {
  const server = $('server').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER
  chrome.storage.sync.set({ server })
  const msg = $('msg')
  msg.textContent = 'Reading cookie…'; msg.className = ''
  try {
    const c = await chrome.cookies.get({ url: 'https://www.pathofexile.com', name: 'POESESSID' })
    if (!c || !c.value) throw new Error('No POESESSID found — log in at pathofexile.com first.')
    msg.textContent = 'Verifying with the dashboard…'
    const r = await fetch(`${server}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: c.value, label: 'chrome extension' }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.detail || `dashboard said HTTP ${r.status}`)
    msg.textContent = body.message || 'Connected — live order book enabled.'
    msg.className = 'ok'
  } catch (e) {
    msg.textContent = String(e.message || e)
    msg.className = 'err'
  }
})
