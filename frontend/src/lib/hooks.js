import { useEffect, useRef, useState } from 'react'
import { cleanErr, toast } from './api.js'

// The one "fetch on mount / on deps" shape: `fn()` returns a promise; the result lands in `data`,
// a failure in `err` (cleaned), `busy` covers the in-flight window. Out-of-order and post-unmount
// responses are dropped. `data` is kept while a refetch is in flight so views can show the last
// result instead of flashing "Loading…". `reload()` refetches with the same deps.
export function useApi(fn, deps) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(true)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true
    setBusy(true)
    Promise.resolve().then(fn)
      .then(d => { if (live) { setData(d); setErr(null) } })
      .catch(e => { if (live) setErr(cleanErr(e)) })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [...deps, nonce]) // eslint-disable-line
  return { data, err, busy, reload: () => setNonce(n => n + 1), setData }
}

// Debounced autosave shared by the editor views. `saver(payload)` persists; the
// returned `save(payload)` debounces it and drives a 'saving'/'saved' indicator,
// `arm()` enables saving (call it once after the initial load so hydrating state
// doesn't trigger a write). Failures surface as a toast.
export function useAutosave(saver, delay = 700) {
  const [state, setState] = useState('')
  const timer = useRef(null)
  const armed = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  const save = (payload) => {
    if (!armed.current) return
    clearTimeout(timer.current)
    setState('saving')
    timer.current = setTimeout(async () => {
      try {
        await saver(payload)
        setState('saved')
        setTimeout(() => setState(s => (s === 'saved' ? '' : s)), 1400)
      } catch (e) { setState(''); toast(cleanErr(e), false) }
    }, delay)
  }
  return { state, save, arm: () => { armed.current = true } }
}
