import React, { useEffect, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const ago = (t) => t ? fmt.age(Date.now() / 1000 - t) + ' ago' : '–'

export default function AccountsPanel({ onChange }) {
  const [sess, setSess] = useState(null)
  const [oa, setOa] = useState(null)
  const [cookie, setCookie] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [ext, setExt] = useState(false)   // browser extension bridge detected
  const host = window.location.origin

  const load = () => Promise.all([api.session(), api.oauthStatus()]).then(([s, o]) => { setSess(s); setOa(o) })
  useEffect(() => {
    load()
    const q = new URLSearchParams(window.location.search)
    if (q.get('oauth') === 'ok') setMsg({ ok: true, text: 'Logged in with Path of Exile.' })
    if (q.get('oauth') === 'error') setMsg({ ok: false, text: `Login failed: ${q.get('msg')}` })
    const onExt = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      const m = event.data
      if (!m || m.source !== 'poe2arb-ext') return
      if (m.cmd === 'hello') setExt(true)
      if (m.cmd === 'connect-result') {
        setBusy(false)
        setMsg({ ok: !!m.ok, text: m.message })
        if (m.ok) { load(); onChange?.() }
      }
    }
    window.addEventListener('message', onExt)
    window.postMessage({ source: 'poe2arb', cmd: 'ping' }, window.location.origin)
    const t = setInterval(load, 15000)   // pick up extension connects without a reload
    return () => { clearInterval(t); window.removeEventListener('message', onExt) }
  }, [])

  const extConnect = () => {
    setBusy(true); setMsg(null)
    window.postMessage({ source: 'poe2arb', cmd: 'connect' }, window.location.origin)
    setTimeout(() => setBusy(b => { if (b) setMsg({ ok: false, text: 'No answer from the extension — reload it on chrome://extensions and refresh this page.' }); return false }), 8000)
  }

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
          {ext ? (
            <div className="row" style={{ margin: '10px 0' }}>
              <button className="btn primary" disabled={busy} onClick={extConnect}>
                {busy ? 'Connecting…' : 'Connect trade session'}</button>
              <span className="hint">One click. If you're not logged in to pathofexile.com yet, the login page opens and the
                session connects itself right after you log in.</span>
            </div>
          ) : (
            <p className="hint"><b>One-click setup (once):</b> open <code>chrome://extensions</code>, turn on Developer mode,
              click <b>Load unpacked</b> and pick <code>tools/chrome-extension/</code> from the repo, then refresh this page —
              a Connect button appears here.</p>
          )}
          <details className="adv">
            <summary>Other ways to connect</summary>
            <p className="hint">Paste it yourself: on pathofexile.com press F12 → Application → Cookies → <code>POESESSID</code>:</p>
            <div className="row">
              <input className="btn" type="password" placeholder="POESESSID" value={cookie} onChange={e => setCookie(e.target.value)} style={{ width: 300 }} autoComplete="off" />
              <button className="btn primary" disabled={!cookie || busy} onClick={connect}>{busy ? 'Verifying…' : 'Connect'}</button>
            </div>
            <p className="hint">Or from the PC where you're logged in: <code>pip install browser-cookie3</code> then
              {' '}<code>python tools/connect.py --server {host} session</code>.</p>
          </details>
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
