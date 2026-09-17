import React, { useEffect, useState } from 'react'
import { api, fmt } from '../lib/api.js'
import { connectBridge, connectSession } from '../lib/session.js'
import { useStatus } from '../lib/statusStore.js'

const ago = (t) => t ? fmt.age(Date.now() / 1000 - t) + ' ago' : '–'

export default function AccountsPanel({ onChange }) {
  // Session + OAuth state ride the app-level status poll (no second poller); `load` = refresh it.
  const sess = useStatus(s => s.status?.session ?? null)
  const oa = useStatus(s => s.status?.oauth ?? null)
  const load = useStatus(s => s.refresh)
  const [cookie, setCookie] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const host = window.location.origin

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('oauth') === 'ok') setMsg({ ok: true, text: 'Logged in with Path of Exile.' })
    if (q.get('oauth') === 'error') setMsg({ ok: false, text: `Login failed: ${q.get('msg')}` })
  }, [])

  const desktop = connectBridge() === 'desktop'   // live order book is a desktop-app feature
  const bridgeConnect = async () => {
    setBusy(true); setMsg(null)
    const r = await connectSession()
    setMsg({ ok: r.ok !== false, text: r.message })
    if (r.ok) { await load(); onChange?.() }
    setBusy(false)
  }

  const connect = async () => {
    setBusy(true); setMsg(null)
    const raw = cookie.trim()
    try {
      const r = await api.connectSession(raw)
      // Desktop: also mirror the cookie into the Electron session so the embedded
      // Trade site is logged in (paste otherwise only reaches the backend).
      if (window.poe2desktop?.setCookie) { try { await window.poe2desktop.setCookie(raw) } catch {} }
      setMsg({ ok: true, text: r.message }); setCookie(''); await load(); onChange?.()
    }
    catch (e) { setMsg({ ok: false, text: String(e.message || e) }) }
    setBusy(false)
  }
  const login = async () => {
    setMsg(null)
    try { const r = await api.oauthStart(); window.location.href = r.url }
    catch (e) { setMsg({ ok: false, text: String(e.message || e) }) }
  }

  return (
    <>
      <h2>Trade session</h2>
      {sess?.connected ? (
        <p className="notice">Connected{sess.label ? ` · ${sess.label}` : ''} · set {ago(sess.set_at)} · last successful fetch {ago(sess.last_ok)}.
          {' '}{sess.source !== 'env' && <button className="btn small" onClick={async () => { await api.disconnectSession(); await load(); onChange?.() }}>Disconnect</button>}
        </p>
      ) : desktop ? (
        <>
          <ol className="hint" style={{ margin: '10px 0', lineHeight: 1.7 }}>
            <li><button className="btn primary small" onClick={() => window.poe2desktop?.openLogin?.()}>Open pathofexile.com login in your browser ↗</button>
              {' '}— sign in there (Steam/Cloudflare work normally in a real browser).</li>
            <li>Press <b>F12 → Application → Cookies → <code>POESESSID</code></b> and copy its value.</li>
            <li>Paste it here:
              <div className="row" style={{ marginTop: 6 }}>
                <input className="btn" type="password" placeholder="POESESSID" value={cookie} onChange={e => setCookie(e.target.value)} style={{ width: 300 }} autoComplete="off" />
                <button className="btn primary" disabled={!cookie || busy} onClick={connect}>{busy ? 'Verifying…' : 'Connect'}</button>
              </div>
            </li>
          </ol>
          <details className="adv">
            <summary>Other ways to connect</summary>
            <div className="row" style={{ margin: '6px 0' }}>
              <button className="btn" disabled={busy} onClick={bridgeConnect}>
                {busy ? 'Connecting…' : 'Connect via in-app login window'}</button>
              <span className="hint">Opens an embedded login. May get stuck on Cloudflare or Steam SSO — prefer the browser steps above.</span>
            </div>
          </details>
          <p className="hint">The cookie is verified with one exchange query, stored encrypted under <code>data/</code>, and only ever sent to pathofexile.com.
            Logging out of the website invalidates it — reconnect afterwards.</p>
        </>
      ) : (
        // Web build: the live order book needs the desktop app's native login — don't
        // advertise the browser-extension flow here. Point at the download instead.
        <p className="hint">Live searches and the sales ledger run in the <b>desktop app</b>, which signs in to pathofexile.com for you —
          grab it from the <b>Download</b> button in the top bar. This website is a preview that uses hourly market data.</p>
      )}

      <h2 style={{ marginTop: 24 }}>Path of Exile account (OAuth, optional)</h2>
      {!oa?.configured ? (
        <p className="hint">Not configured — only needed for account features (profile, characters), not for trading data.
          See README → OAuth if you want it.</p>
      ) : oa.logged_in ? (
        <p className="hint">Logged in as <b>{oa.username}</b> · access token renews {ago(oa.expires_at).replace(' ago', '')} from now.</p>
      ) : (
        <p className="hint">Client <code>{oa.client_id}</code> ({oa.client_type}), redirect <code>{oa.redirect_uri}</code>.</p>
      )}
      {oa?.configured && (
        <div className="row">
          {!oa.logged_in && <button className="btn primary" onClick={login}>Log in with Path of Exile</button>}
          {oa.logged_in && <button className="btn" onClick={async () => { await api.oauthLogout(); await load(); onChange?.() }}>Log out</button>}
        </div>
      )}
      {oa?.configured && !oa.logged_in && (
        <p className="hint">The button works when the dashboard is open at <code>{oa.redirect_uri.replace(/\/callback$/, '')}</code> (same machine or SSH tunnel);
          from another PC run <code>python tools/connect.py --server {host} oauth</code> instead.</p>
      )}
      {msg && <p className={`notice ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}
    </>
  )
}
