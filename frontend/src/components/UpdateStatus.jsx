import React, { useEffect, useState } from 'react'
import { isDesktop } from '../lib/session.js'

// Version + seamless updater, merged into ONE topbar element (desktop only). Idle, it IS the
// version chip (click → check for updates); when electron-updater reports activity it morphs in
// place through checking → downloading → ready/install. Hidden in the browser (web uses DownloadApp).
export default function UpdateStatus({ version }) {
  const bridge = isDesktop ? window.poe2desktop : null
  const [st, setSt] = useState(null)

  useEffect(() => {
    if (!bridge?.onUpdate) return
    const off = bridge.onUpdate(setSt)
    return off
  }, []) // eslint-disable-line

  if (!bridge?.onUpdate) return null

  if (st?.phase === 'downloading') {
    return <span className="update-chip busy" title="Downloading the latest version">
      <i className="spin" /> Updating{st.percent ? ` ${st.percent}%` : '…'}
    </span>
  }
  if (st?.phase === 'ready') {
    return <button className="update-chip ready" title={`Version ${st.version || ''} downloaded — click to install and restart`}
      onClick={() => bridge.installUpdate()}>↻ Install update{st.version ? ` ${st.version}` : ''}</button>
  }
  if (st?.phase === 'manual') {
    // macOS (unsigned): can't hot-swap, so the button opens the DMG for a drag-install.
    return <button className="update-chip ready" title={`Download Arbiter ${st.version || ''} — open the DMG and drag to Applications`}
      onClick={() => bridge.installUpdate()}>↓ Update{st.version ? ` ${st.version}` : ''}</button>
  }
  if (st?.phase === 'checking') return <span className="update-chip" title="Checking for updates">checking…</span>
  if (st?.phase === 'error') return <span className="update-chip err" title={st.message || 'update check failed'}>update error</span>

  // Idle (no event yet, or phase 'none'): the merged version chip. Click checks for updates;
  // a ✓ marks that the last check found us current.
  const uptodate = st?.phase === 'none'
  return (
    <button className={`ver-chip ${uptodate ? 'ok' : ''}`} onClick={() => bridge.checkUpdate?.()}
      title={uptodate ? "You're on the latest version — click to re-check" : 'Click to check for updates'}>
      v{version || '?'}{uptodate ? ' ✓' : ''}
    </button>
  )
}
