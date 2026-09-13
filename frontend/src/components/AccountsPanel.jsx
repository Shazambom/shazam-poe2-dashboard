import React, { useEffect, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const ago = (t) => t ? fmt.age(Date.now() / 1000 - t) + ' ago' : '–'

export default function AccountsPanel({ onChange }) {
  const [sess, setSess] = useState(null)
  const [oa, setOa] = useState(null)
  const [cookie, setCookie] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const host = window.location.origin

  const load = () => Promise.all([api.session(), api.oauthStatus()]).then(([s, o]) => { setSess(s); setOa(o) })
  useEffect(() => {
    load()
    const q = new URLSearchParams(window.location.search)
    if (q.get('oauth') === 'ok') setMsg({ ok: true, text: 'Logged in with Path of Exile.' })
    if (q.get('oauth') === 'error') setMsg({ ok: false, text: `Login failed: ${q.get('msg')}` })
    const t = setInterval(load, 15000)   // pick up extension connects without a reload
    return () => clearInterval(t)
  }, [])

  const connect = async () => {
    setBusy(true); setMsg(null)
    try { const r = await api.connectSession(cookie.trim()); setMsg({ ok: true, text: r.message }); setCookie(''); await load(); onChange?.() }
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
      <h2>Trade session (live order book)</h2>
      {sess?.connected ? (
        <p className="notice">Connected{sess.label ? ` · ${sess.label}` : ''} · set {ago(sess.set_at)} · last successful fetch {ago(sess.last_ok)}.
          {' '}{sess.source !== 'env' && <button className="btn small" onClick={async () => { await api.disconnectSession(); await load(); onChange?.() }}>Disconnect</button>}
        </p>
      ) : (
        <>
          <p className="hint">The exchange API only accepts the website's own login cookie (<code>POESESSID</code>), and browsers
            hide it from page scripts — so it has to be handed over once. Pick whichever is easiest:</p>
          <p className="hint"><b>1. One-click browser extension</b> (recommended, reconnects in one click forever):
            load <code>tools/chrome-extension/</code> from the repo via <code>chrome://extensions</code> → Developer mode → Load unpacked,
            log in to pathofexile.com normally, then click the extension → Connect. Done.</p>
          <p className="hint"><b>2. Paste it</b>: on pathofexile.com press F12 → Application → Cookies → <code>POESESSID</code>, copy the value:</p>
          <div className="row">
            <input className="btn" type="password" placeholder="POESESSID" value={cookie} onChange={e => setCookie(e.target.value)} style={{ width: 300 }} autoComplete="off" />
            <button className="btn primary" disabled={!cookie || busy} onClick={connect}>{busy ? 'Verifying…' : 'Connect'}</button>
          </div>
          <p className="hint"><b>3. Helper script</b>: <code>pip install browser-cookie3</code> then <code>python tools/connect.py --server {host} session</code> on the PC where you're logged in.</p>
        </>
      )}
      <p className="hint">The cookie is verified with one exchange query, stored encrypted under <code>data/</code>, and only ever sent to pathofexile.com.
        Logging out of the website invalidates it — reconnect afterwards.</p>

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
