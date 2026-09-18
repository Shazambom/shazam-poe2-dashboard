import React, { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../lib/api.js'
import { THEMES, DEFAULT_THEME, useTheme } from '../lib/themeStore.js'
import { presetTables } from '../lib/themeCss.js'
import {
  PRIMARIES, DERIVED_KEYS, isTriplet, primariesOf, rederive, derive, contrastIssues, autoFixContrast,
  exportCss, exportJson, newThemeId,
} from '../lib/themeDerive.js'
import { hexToTriplet, rgbToHex } from '../lib/color.js'

// Custom themes — Settings → Appearance → "Custom themes". A custom theme is a colour table for the same
// tokens the presets define: eight primaries the user picks, everything else derived (lib/themeDerive.js)
// and pinnable under Advanced. The live preview is the app itself. Presets are read-only: "New from…"
// copies one, then you edit the copy. Export hands back a ready-to-paste preset block + JSON so a tweaked
// copy can be codified in styles.css as a shipped default.

// The presets' colour tables come from styles.css itself (loaded on demand, only in the builder).
let presetsPromise = null
const loadPresets = () => (presetsPromise ??= import('../styles.css?raw').then(m => presetTables(m.default).tables))

const NAMES = Object.fromEntries(THEMES.map(t => [t.id, t.name]))
const tripletToHex = (v) => rgbToHex(String(v).split(',').map(Number))
const swatchHex = (k, v) => (isTriplet(k) ? tripletToHex(v) : v)
const label = (k) => k.replace(/^--/, '')

export default function ThemeBuilder() {
  const customs = useTheme(s => s.customs)
  const chosen = useTheme(s => s.id)
  const [presets, setPresets] = useState(null)
  const [base, setBase] = useState('vault')
  const [editId, setEditId] = useState(null)
  const [draft, setDraft] = useState(null)      // the theme being edited (unsaved edits live here)
  const [exported, setExported] = useState('')
  const saveTimer = useRef(null)
  const previewTimer = useRef(null)

  useEffect(() => { loadPresets().then(setPresets).catch(() => {}) }, [])
  // Leaving the builder ends any preview (the chosen theme comes back).
  useEffect(() => () => { clearTimeout(previewTimer.current); useTheme.getState().endPreview() }, [])

  const editing = useMemo(() => customs.find(t => t.id === editId) || null, [customs, editId])
  useEffect(() => { setDraft(editing ? { ...editing, colors: { ...editing.colors } } : null); setExported('') }, [editing?.id]) // eslint-disable-line

  const persist = (list) => useTheme.getState().saveCustoms(list).catch(() => toast('Could not save themes', false))
  const upsert = (theme) => persist(customs.some(t => t.id === theme.id) ? customs.map(t => (t.id === theme.id ? theme : t)) : [...customs, theme])

  // Edits: paint at once (debounced a frame or two), save after the hand stops moving.
  const update = (next) => {
    setDraft(next)
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => useTheme.getState().preview(next.colors), 60)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => upsert(next), 800)
  }
  const setPrimary = (k, hex) => update({ ...draft, colors: rederive(draft.colors, { ...primariesOf(draft.colors), [k]: hex }) })
  const setDerived = (k, hex) => update({ ...draft, colors: { ...draft.colors, [k]: isTriplet(k) ? hexToTriplet(hex) : hex } })
  const resetDerived = (k) => setDerived(k, swatchHex(k, derive(primariesOf(draft.colors))[k]))

  const create = () => {
    if (!presets?.[base]) return
    const theme = { id: newThemeId(), name: `${NAMES[base] || base} copy`, base, colors: { ...presets[base] } }
    upsert(theme); setEditId(theme.id)
  }
  const duplicate = (t) => { const theme = { ...t, id: newThemeId(), name: `${t.name} copy`, colors: { ...t.colors } }; upsert(theme); setEditId(theme.id) }
  const remove = (t) => {
    if (!window.confirm(`Delete theme "${t.name}"?`)) return
    clearTimeout(saveTimer.current); clearTimeout(previewTimer.current)
    if (editId === t.id) setEditId(null)
    if (t.id === chosen) useTheme.getState().apply(DEFAULT_THEME)
    persist(customs.filter(x => x.id !== t.id))
  }
  const doExport = (t) => {
    const text = `${exportCss(t)}\n${exportJson(t)}\n`
    setEditId(t.id); setExported(text)
    navigator.clipboard?.writeText(text).then(() => toast('Theme CSS + JSON copied')).catch(() => {})
  }
  const use = (t) => { clearTimeout(previewTimer.current); useTheme.getState().apply(t.id) }

  const issues = draft ? contrastIssues(draft.colors) : []

  return (
    <details className="adv">
      <summary>Custom themes{customs.length ? ` (${customs.length})` : ''}</summary>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="hint">New from</span>
        <select value={base} onChange={e => setBase(e.target.value)} style={{ width: 200 }}>
          {THEMES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn small" disabled={!presets} onClick={create}>Create</button>
      </div>

      {customs.length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <tbody>
            {customs.map(t => (
              <tr key={t.id}>
                <td><button className="btn small" style={{ fontWeight: t.id === editId ? 700 : 400 }} onClick={() => setEditId(t.id)}>{t.name}</button></td>
                <td className="hint">{t.id === chosen ? 'in use' : NAMES[t.base] ? `from ${NAMES[t.base]}` : ''}</td>
                <td>
                  <div className="row">
                    <button className="btn small" disabled={t.id === chosen} onClick={() => use(t)}>Use</button>
                    <button className="btn small" onClick={() => duplicate(t)}>Duplicate</button>
                    <button className="btn small" onClick={() => doExport(t)}>Export</button>
                    <button className="btn small" onClick={() => remove(t)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <div>
          <div className="field"><label>Name</label>
            <input value={draft.name} onChange={e => update({ ...draft, name: e.target.value })} />
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            {PRIMARIES.map(([k, name]) => (
              <div className="field" key={k} style={{ marginBottom: 0, width: 84 }}><label>{name}</label>
                <input type="color" value={draft.colors[k]} onChange={e => setPrimary(k, e.target.value)} title={label(k)} style={{ height: 30, padding: 2 }} />
              </div>
            ))}
          </div>
          {issues.length > 0 && (
            <p className="hint" style={{ marginTop: 0 }}>
              {issues.map(i => `${label(i.fg)} on ${label(i.bg)} is ${i.ratio.toFixed(1)}:1 (needs ${i.min}:1)`).join(' · ')}
              {' '}<button className="btn small" onClick={() => update({ ...draft, colors: autoFixContrast(draft.colors) })}>Auto-fix</button>
            </p>
          )}
          <details className="adv">
            <summary>Advanced — derived colours</summary>
            <div className="row" style={{ marginBottom: 8 }}>
              {DERIVED_KEYS.filter(k => !isTriplet(k) || k === '--wash-rgb').map(k => (
                <div className="field" key={k} style={{ marginBottom: 0, width: 84 }}><label>{label(k)}</label>
                  <div className="row" style={{ gap: 2 }}>
                    <input type="color" value={swatchHex(k, draft.colors[k])} onChange={e => setDerived(k, e.target.value)} title={k} style={{ height: 30, padding: 2, width: 44 }} />
                    <button className="btn small" onClick={() => resetDerived(k)} title="Back to the derived value">↺</button>
                  </div>
                </div>
              ))}
            </div>
          </details>
          {exported && <pre className="diag-pre">{exported}</pre>}
        </div>
      )}
    </details>
  )
}
