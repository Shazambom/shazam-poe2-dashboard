import React, { useEffect, useState } from 'react'

// "Download desktop app" button for the web dashboard. Reads the latest GitHub release and
// links to the OS-specific installer asset, so the link always points at the current version
// (no hardcoded filename). Hidden inside the desktop app itself.
const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop
const RELEASES = 'https://github.com/Shazambom/shazam-poe2-dashboard/releases/latest'
const API = 'https://api.github.com/repos/Shazambom/shazam-poe2-dashboard/releases/latest'
const osKind = () => {
  const s = (navigator.userAgent + ' ' + (navigator.platform || '')).toLowerCase()
  if (s.includes('win')) return 'win'
  if (s.includes('mac')) return 'mac'
  return null
}
// The OS installer among the release assets: Windows -> the NSIS .exe, Mac -> the .dmg
// (skip the .blockmap sidecars).
const pickAsset = (assets, os) => {
  const want = os === 'win' ? /\.exe$/i : /\.dmg$/i
  return assets.find(a => want.test(a.name) && !/\.blockmap$/i.test(a.name)) || null
}

export default function DownloadApp() {
  const [rel, setRel] = useState(null)   // { name, url, version }
  const [os] = useState(osKind)

  useEffect(() => {
    if (isDesktop || !os) return
    fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => {
        const a = pickAsset(j.assets || [], os)
        if (a) setRel({ name: a.name, url: a.browser_download_url, version: (j.tag_name || '').replace(/^desktop-v/, '') })
      })
      .catch(() => {})
  }, [os])

  if (isDesktop) return null
  const label = os === 'mac' ? 'Download for Mac' : os === 'win' ? 'Download for Windows' : 'Get the desktop app'
  // Fall back to the GitHub releases page if we couldn't resolve a direct asset.
  const href = rel ? rel.url : RELEASES
  return (
    <a className="download-app" href={href} download title="Desktop app: native PoE login, local data, seamless auto-updates">
      <span className="dl-arrow" aria-hidden="true">↓</span>
      <span>{label}{rel?.version ? ` ${rel.version}` : ''}</span>
    </a>
  )
}
