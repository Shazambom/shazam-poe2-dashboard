import React, { useEffect, useState } from 'react'

// "Download desktop app" button for the web dashboard. Reads the electron-updater
// manifest at /downloads so the link always points at the current version's
// installer (no hardcoded filename). Hidden inside the desktop app itself.
const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop
const osKind = () => {
  const s = (navigator.userAgent + ' ' + (navigator.platform || '')).toLowerCase()
  if (s.includes('win')) return 'win'
  if (s.includes('mac')) return 'mac'
  return null
}

export default function DownloadApp() {
  const [file, setFile] = useState(null)
  const [os] = useState(osKind)

  useEffect(() => {
    if (isDesktop || !os) return
    const manifest = os === 'win' ? 'latest.yml' : 'latest-mac.yml'
    fetch(`/downloads/${manifest}`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(txt => {
        // electron-updater yml: a top-level `path:` (and per-file `url:`) names the installer.
        const m = txt.match(/^path:\s*(.+?)\s*$/m) || txt.match(/url:\s*(.+?\.(?:exe|dmg))\s*$/m)
        const v = txt.match(/^version:\s*(.+?)\s*$/m)
        if (m) setFile({ name: m[1].trim(), version: v ? v[1].trim() : null })
      })
      .catch(() => {})
  }, [os])

  if (isDesktop) return null
  const label = os === 'mac' ? 'Download for Mac' : os === 'win' ? 'Download for Windows' : 'Get the desktop app'
  // Fall back to the downloads index if we couldn't parse a filename or OS is unknown.
  const href = file ? `/downloads/${encodeURIComponent(file.name)}` : '/downloads/'
  return (
    <a className="download-app" href={href} download title="Desktop app: native PoE login, local data, seamless auto-updates">
      <span className="dl-arrow" aria-hidden="true">↓</span>
      <span>{label}{file?.version ? ` ${file.version}` : ''}</span>
    </a>
  )
}
