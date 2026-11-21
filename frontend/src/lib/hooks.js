import { startPoll } from './poll.js'
import { createAutosave } from './autosave.js'
import { useEffect, useRef, useState } from 'react'
import { cleanErr, toast } from './api.js'
import { useSync } from './syncStore.js'

// The one "fetch on mount / on deps" shape: `fn()` returns a promise; the result lands in `data`,
// a failure in `err` (cleaned), `busy` covers the in-flight window. Out-of-order and post-unmount
// responses are dropped. `data` is kept while a refetch is in flight so views can show the last
// result instead of flashing "Loading…". `reload()` refetches with the same deps — and so does the
// topbar ⟳ (the sync store's `tick`), so every view that loads through this hook answers the one
// app-wide refresh button instead of silently ignoring it.
export function useApi(fn, deps) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(true)
  const [nonce, setNonce] = useState(0)
  const tick = useSync(s => s.tick)
  useEffect(() => {
    let live = true
    setBusy(true)
    Promise.resolve().then(fn)
      .then(d => { if (live) { setData(d); setErr(null) } })
      .catch(e => { if (live) setErr(cleanErr(e)) })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [...deps, nonce, tick]) // eslint-disable-line
  return { data, err, busy, reload: () => setNonce(n => n + 1), setData }
}

// Debounced autosave shared by the editor views. `saver(payload)` persists; the
// returned `save(payload)` debounces it and drives a 'saving'/'saved' indicator,
// `arm()` enables saving (call it once after the initial load so hydrating state
// doesn't trigger a write). Failures surface as a toast.
export function useAutosave(saver, delay = 700) {
  const [state, setState] = useState('')
  const ctrl = useRef(null)
  if (!ctrl.current) {
    ctrl.current = createAutosave(saver, delay, {
      onState: setState,
      onError: (e) => toast(cleanErr(e), false),
    })
  }
  ctrl.current.setSaver(saver)
  useEffect(() => { ctrl.current.mount(); return () => ctrl.current.unmount() }, [])
  const { save, flush, hold, release, discard, arm } = ctrl.current
  return { state, save, flush, hold, release, discard, arm }
}

// `value`, once it has held still for `ms`: typing in a filter box re-runs a search once, not per keystroke.
export function useDebounced(value, ms = 500) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

// Poll `fn` every `ms` while the window is visible, and at once when the user comes back to it
// (lib/poll.js). Restarts when `deps` change.
export function usePoll(fn, ms, deps = []) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => startPoll(() => ref.current(), ms), [ms, ...deps]) // eslint-disable-line
}
