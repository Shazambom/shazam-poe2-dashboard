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
  }, [])

  const connect = async () => {
    setBusy(true); setMsg(null)
    try { const r = await api.connectSession(cookie); setMsg({ ok: true, text: r.message }); setCookie(''); await load(); onChange?.() }
    catch (e) { setMsg({ ok: false, text: String(e.message || e).replace(/^\d+ /, '').replace(/^\{"detail":"|"\}$/g, '') }) }
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
        <p className="hint">Connected{sess.source === 'env' ? ' from .env (legacy)' : ''}{sess.label ? ` · ${sess.label}` : ''} · set {ago(sess.set_at)} · last successful fetch {ago(sess.last_ok)}.</p>
      ) : (
        <p className="hint">Not connected. The exchange only accepts the website's own session cookie, and that cookie is HttpOnly, so it has to come from your browser's cookie store.</p>
      )}
      <p className="hint">Easiest: on the PC where you're logged in to pathofexile.com, run<br />
        <code>pip install browser-cookie3</code> then <code>python tools/connect.py --server {host} session</code></p>
      <p className="hint">Or paste it: devtools (F12) → Application/Storage → Cookies → pathofexile.com → <code>POESESSID</code>.</p>
      <div className="row">
        <input className="btn" type="password" placeholder="POESESSID" value={cookie} onChange={e => setCookie(e.target.value)} style={{ width: 300 }} autoComplete="off" />
        <button className="btn primary" disabled={!cookie || busy} onClick={connect}>{busy ? 'Verifying' : 'Connect'}</button>
        {sess?.connected && sess.source !== 'env' && <button className="btn" onClick={async () => { await api.disconnectSession(); await load(); onChange?.() }}>Disconnect</button>}
      </div>
      <p className="hint">Stored encrypted under <code>data/</code>; only ever sent to pathofexile.com. Logging out of the website invalidates it — reconnect afterwards.</p>

      <h2 style={{ marginTop: 24 }}>Path of Exile account (OAuth)</h2>
      {!oa?.configured ? (
        <p className="hint">Not configured. Register a client with GGG (README → OAuth), put <code>OAUTH_CLIENT_ID</code> in <code>.env</code>, restart. This unlocks account features going forward: profile, characters, and whatever GGG adds for PoE2.</p>
      ) : oa.logged_in ? (
        <p className="hint">Logged in as <b>{oa.username}</b> · scope {oa.scope} · access token renews {ago(oa.expires_at).replace(' ago', '')} from now · refresh valid until {oa.refresh_expires_at ? new Date(oa.refresh_expires_at * 1000).toLocaleDateString() : '–'}.</p>
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
        <p className="hint">The button works when this dashboard is open at <code>{oa.redirect_uri.replace(/\/callback$/, '')}</code> (same machine, or an SSH tunnel). From another PC on the LAN, run <code>python tools/connect.py --server {host} oauth</code> there instead — it catches the redirect locally and hands the code to the dashboard.</p>
      )}
      {msg && <p className={`notice ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}
    </>
  )
}
