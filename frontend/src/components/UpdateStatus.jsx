import React, { useEffect, useState } from 'react'

// Seamless in-app updater UI (desktop only). electron-updater downloads new versions
// in the background; this shows a spinner during download and a one-click Install
// button when ready — no download page, no manual binary. Hidden in the browser.
export default function UpdateStatus() {
  const bridge = typeof window !== 'undefined' && window.poe2desktop
  const [st, setSt] = useState(null)

  useEffect(() => {
    if (!bridge?.onUpdate) return
    const off = bridge.onUpdate(setSt)
    return off
  }, []) // eslint-disable-line

  if (!bridge?.onUpdate || !st) return null
  if (st.phase === 'downloading') {
    return <span className="update-chip busy" title="Downloading the latest version">
      <i className="spin" /> Updating{st.percent ? ` ${st.percent}%` : '…'}
    </span>
  }
  if (st.phase === 'ready') {
    return <button className="update-chip ready" title={`Version ${st.version || ''} downloaded — click to install and restart`}
      onClick={() => bridge.installUpdate()}>↻ Install update{st.version ? ` ${st.version}` : ''}</button>
  }
  return null   // checking / none / error → stay quiet
}
