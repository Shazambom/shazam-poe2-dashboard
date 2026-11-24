import { ignoredError } from '../lib/ignoredError.js'
import { scheduleUserSave } from '../lib/quitFlush.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../lib/api.js'
import { THEMES, DEFAULT_THEME, useTheme } from '../lib/themeStore.js'
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

// The presets' colour tables are extracted from styles.css at build time (vite.config.js), loaded on demand.
let presetsPromise = null
const loadPresets = () => (presetsPromise ??= import('virtual:theme-presets').then(m => m.default))

const NAMES = Object.fromEntries(THEMES.map(t => [t.id, t.name]))
const tripletToHex = (v) => rgbToHex(String(v).split(',').map(Number))
const swatchHex = (k, v) => (isTriplet(k) ? tripletToHex(v) : v)
const label = (k) => k.replace(/^--/, '')

const persistCustoms = (list) => useTheme.getState().saveCustoms(list).catch(() => { toast('Could not save themes', false); return false })
const upsertCustom = (theme) => {
  const list = useTheme.getState().customs
  return persistCustoms(list.some(t => t.id === theme.id) ? list.map(t => (t.id === theme.id ? theme : t)) : [...list, theme])
}

export default function ThemeBuilder() {
  const customs = useTheme(s => s.customs)
  const chosen = useTheme(s => s.id)
  const [presets, setPresets] = useState(null)
  const [base, setBase] = useState('vault')
  const [editId, setEditId] = useState(null)
  const [draft, setDraft] = useState(null)      // the theme being edited (unsaved edits live here)
  const [exported, setExported] = useState(null)   // { id, text }: the last export, shown while its theme is open
  const pendingSave = useRef(null)                 // { id, theme, cancel }
  const previewTimer = useRef(null)

  const cancelPending = () => {
    const p = pendingSave.current
    if (!p) return
    pendingSave.current = null
    p.cancel()
  }
  const flushPending = () => {
    const p = pendingSave.current
    if (!p) return
    pendingSave.current = null
    p.cancel()
    return upsertCustom(p.theme)
  }

  useEffect(() => { loadPresets().then(setPresets).catch(() => ignoredError('load theme presets')) }, [])
  // Leaving the builder flushes any pending edit, cancels the preview timer, and restores the chosen theme.
  useEffect(() => () => {
    clearTimeout(previewTimer.current)
    const p = pendingSave.current
    if (p) {
      pendingSave.current = null
      p.cancel()
      upsertCustom(p.theme)
    }
    useTheme.getState().endPreview()
  }, [])

  const editing = useMemo(() => customs.find(t => t.id === editId) || null, [customs, editId])
  const editingId = editing?.id
  const [draftId, setDraftId] = useState(editingId)
  if (draftId !== editingId) {
    setDraftId(editingId)
    setDraft(editing ? { ...editing, colors: { ...editing.colors } } : null)
    setExported(e => (e?.id === editingId ? e : null))
  }

  // Edits: paint at once (debounced a frame or two), save after the hand stops moving.
  const update = (next) => {
    setDraft(next)
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => useTheme.getState().preview(next.colors), 60)
    if (pendingSave.current && pendingSave.current.id !== next.id) flushPending()
    else cancelPending()
    const cancel = scheduleUserSave(() => {
      if (pendingSave.current?.cancel === cancel) pendingSave.current = null
      return upsertCustom(next)
    }, 800)
    pendingSave.current = { id: next.id, theme: next, cancel }
  }
  const setPrimary = (k, hex) => update({ ...draft, colors: rederive(draft.colors, { ...primariesOf(draft.colors), [k]: hex }) })
  const setDerived = (k, hex) => update({ ...draft, colors: { ...draft.colors, [k]: isTriplet(k) ? hexToTriplet(hex) : hex } })
  const resetDerived = (k) => setDerived(k, swatchHex(k, derive(primariesOf(draft.colors))[k]))

  const create = () => {
    if (!presets?.[base]) return
    flushPending()
    const theme = { id: newThemeId(), name: `${NAMES[base] || base} copy`, base, colors: { ...presets[base] } }
    upsertCustom(theme); setEditId(theme.id)
  }
  const duplicate = (t) => {
    flushPending()
    const latest = useTheme.getState().customs.find(x => x.id === t.id) || t
    const theme = { ...latest, id: newThemeId(), name: `${latest.name} copy`, colors: { ...latest.colors } }
    upsertCustom(theme); setEditId(theme.id)
  }
  const remove = (t) => {
    if (!window.confirm(`Delete theme "${t.name}"?`)) return
    if (pendingSave.current?.id === t.id) cancelPending()
    else flushPending()
    clearTimeout(previewTimer.current)
    if (editId === t.id) setEditId(null)
    if (t.id === chosen) useTheme.getState().apply(DEFAULT_THEME)
    persistCustoms(useTheme.getState().customs.filter(x => x.id !== t.id))
  }
  const doExport = (t) => {
    const text = `${exportCss(t)}\n${exportJson(t)}\n`
    setEditId(t.id); setExported({ id: t.id, text })
    navigator.clipboard?.writeText(text).then(() => toast('Theme CSS + JSON copied')).catch(() => {
      ignoredError('copy theme export')
      setExported({ id: t.id, text })   // not copied: the text stays in the export box to copy by hand
    })
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
        <button type="button" className="btn small" disabled={!presets} onClick={create}>Create</button>
      </div>

      {customs.length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <tbody>
            {customs.map(t => (
              <tr key={t.id}>
                <td><button type="button" className="btn small" style={{ fontWeight: t.id === editId ? 700 : 400 }} onClick={() => setEditId(t.id)}>{t.name}</button></td>
                <td className="hint">{t.id === chosen ? 'in use' : NAMES[t.base] ? `from ${NAMES[t.base]}` : ''}</td>
                <td aria-label={`Actions for ${t.name}`}>
                  <div className="row">
                    <button type="button" className="btn small" disabled={t.id === chosen} onClick={() => use(t)}>Use</button>
                    <button type="button" className="btn small" onClick={() => duplicate(t)}>Duplicate</button>
                    <button type="button" className="btn small" onClick={() => doExport(t)}>Export</button>
                    <button type="button" className="btn small" onClick={() => remove(t)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <div>
          <div className="field"><label htmlFor="theme-draft-name">Name</label>
            <input id="theme-draft-name" value={draft.name} onChange={e => update({ ...draft, name: e.target.value })} />
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
              {' '}<button type="button" className="btn small" onClick={() => update({ ...draft, colors: autoFixContrast(draft.colors) })}>Auto-fix</button>
            </p>
          )}
          <details className="adv">
            <summary>Advanced — derived colours</summary>
            <div className="row" style={{ marginBottom: 8 }}>
              {DERIVED_KEYS.filter(k => !isTriplet(k) || k === '--wash-rgb').map(k => (
                <div className="field" key={k} style={{ marginBottom: 0, width: 84 }}><label>{label(k)}</label>
                  <div className="row" style={{ gap: 2 }}>
                    <input type="color" value={swatchHex(k, draft.colors[k])} onChange={e => setDerived(k, e.target.value)} title={k} style={{ height: 30, padding: 2, width: 44 }} />
                    <button type="button" className="btn small" onClick={() => resetDerived(k)} title="Back to the derived value">↺</button>
                  </div>
                </div>
              ))}
            </div>
          </details>
          {exported && exported.id === editingId && <pre className="diag-pre">{exported.text}</pre>}
        </div>
      )}
    </details>
  )
}
