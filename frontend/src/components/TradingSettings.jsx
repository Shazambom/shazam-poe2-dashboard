import React, { useEffect, useRef, useState } from 'react'
import { toast } from '../lib/api.js'
import { isDesktop } from '../lib/session.js'
import { useWorkspace, exportWorkspace } from '../lib/workspaceStore.js'
import { saveHistoryPrefs, clearHistoryWithUndo } from '../lib/ee2History.js'
import Toggle from './Toggle.jsx'

// Settings → Trading → Workspace: export the curated searches (history excluded) / import a file.
function WorkspaceTransfer() {
  const fileRef = useRef(null)
  const [mode, setMode] = useState('merge')
  const doExport = () => {
    const doc = exportWorkspace(useWorkspace.getState().tree)
    const text = JSON.stringify(doc, null, 1)
    const name = `arbiter-searches-${new Date().toISOString().slice(0, 10)}.json`
    if (window.poe2desktop?.ws?.exportFile) {   // desktop: main writes into Downloads (the sandboxed page can't download a blob)
      window.poe2desktop.ws.exportFile(name, text).then(p => toast(`Saved ${p}`)).catch(() => toast('Export failed', false))
      return
    }
    const blob = new Blob([text], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    toast('Searches exported (history excluded)')
  }
  const onFile = (e) => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    f.text().then(t => {
      let doc; try { doc = JSON.parse(t) } catch { toast('Not a JSON file', false); return }
      const r = useWorkspace.getState().importWorkspace(doc, mode)
      if (r.error) toast(r.error, false); else toast(`Imported ${r.added} item${r.added === 1 ? '' : 's'} (${mode})`)
    })
  }
  return (
    <>
      <h4 className="settings-sub">Workspace</h4>
      <div className="set-row">
        <button className="btn small" onClick={doExport}>Export searches…</button>
        <button className="btn small" onClick={() => fileRef.current?.click()}>Import…</button>
        <span className="seg">
          <button className={`seg-btn ${mode === 'merge' ? 'on' : ''}`} onClick={() => setMode('merge')} title="Add the file's searches next to yours">Merge</button>
          <button className={`seg-btn ${mode === 'replace' ? 'on' : ''}`} onClick={() => setMode('replace')} title="Replace your curated searches with the file's (the EE2 history folder is kept)">Replace</button>
        </span>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} aria-label="Import searches file" />
        <span className="muted" style={{ fontSize: 12 }}>the EE2 history folder never travels</span>
      </div>
    </>
  )
}

// Settings → Trading → ExiledExchange2 history: the same slider as the workspace rail (one setting),
// the cap and retention, clear, and a status line from main's consumer.
function Ee2HistorySettings() {
  const prefs = useWorkspace(s => s.historyPrefs)
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let live = true
    const poll = () => window.poe2desktop?.ee2?.status?.().then(st => { if (live) setStatus(st) }).catch(() => {})
    poll(); const t = setInterval(poll, 10000)
    return () => { live = false; clearInterval(t) }
  }, [])
  const num = (key, lo, hi) => (e) => { const v = Math.min(hi, Math.max(lo, Math.round(Number(e.target.value) || lo))); saveHistoryPrefs({ [key]: v }) }
  const line = !status ? '' : status.present ? 'ExiledExchange2 connected' : 'ExiledExchange2 not detected'
  return (
    <>
      <h4 className="settings-sub">ExiledExchange2 history</h4>
      <div className="set-row"><Toggle checked={prefs.enabled} onChange={v => saveHistoryPrefs({ enabled: v })} label="Record copied items" /></div>
      <div className="set-row"><span style={{ width: 120 }}>Keep last</span><input type="number" min={20} max={1000} step={10} defaultValue={prefs.max} key={`max${prefs.max}`} onBlur={num('max', 20, 1000)} style={{ width: 90 }} /><span className="muted" style={{ fontSize: 12 }}>entries (20–1000)</span></div>
      <div className="set-row"><span style={{ width: 120 }}>Keep for</span><input type="number" min={7} max={90} defaultValue={prefs.retentionDays} key={`ret${prefs.retentionDays}`} onBlur={num('retentionDays', 7, 90)} style={{ width: 90 }} /><span className="muted" style={{ fontSize: 12 }}>days (7–90)</span></div>
      <div className="set-row"><span style={{ width: 120 }} /><button className="btn small" onClick={() => clearHistoryWithUndo()}>Clear history</button><span className="muted ee2-status" style={{ fontSize: 12 }}>{line}</span></div>
    </>
  )
}


// Trading settings: the global focus hotkey (desktop). Notifications live in NotificationsPanel.
export default function TradingSettings() {
  const ee2Present = useWorkspace(s => s.ee2Present)
  const [hotkey, setHotkey] = useState('CommandOrControl+G')
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (window.poe2desktop?.hotkey) window.poe2desktop.hotkey.get().then(r => setHotkey(r?.combo || 'CommandOrControl+G')).catch(() => {})
  }, [])

  // Capture a key combo for the hotkey (desktop).
  const onKey = (e) => {
    if (!capturing) return
    e.preventDefault()
    const mods = []
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
    const combo = [...mods, key].join('+')
    setCapturing(false)
    window.poe2desktop.hotkey.set(combo).then(r => {
      if (r?.ok) { setHotkey(combo); toast(`Hotkey set to ${combo}`) }
      else toast(`${combo} is taken by another app — pick another`, false)
    })
  }

  return (
    <section className="settings-section">
      <h3>Trading</h3>
      <WorkspaceTransfer />
      {isDesktop && ee2Present && <Ee2HistorySettings />}
      {isDesktop ? (
        <div className="set-row">
          <span style={{ width: 120 }}>Focus hotkey</span>
          <button className="btn small" tabIndex={0} onKeyDown={onKey} onClick={() => setCapturing(true)}>
            {capturing ? 'Press a combo…' : hotkey.replace('CommandOrControl', '⌘/Ctrl')}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>raises Arbiter to Trading → Live</span>
        </div>
      ) : (
        <div className="set-row muted" style={{ fontSize: 12 }}>Global focus hotkey is available in the desktop app.</div>
      )}
    </section>
  )
}
