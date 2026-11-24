import { createStore, useStore } from 'zustand'
import { startPoll } from './poll.js'
import { createAutosave } from './autosave.js'
import { useEffect, useEffectEvent, useLayoutEffect, useState } from 'react'
import { cleanErr, toast } from './api.js'
import { useSync } from './syncStore.js'

// The one "fetch on mount / on deps" shape: `fn()` returns a promise; the result lands in `data`,
// a failure in `err` (cleaned), `busy` covers the in-flight window. Out-of-order and post-unmount
// responses are dropped. `data` is kept while a refetch is in flight so views can show the last
// result instead of flashing "Loading…", and after a failed reload of the same inputs; a failed load of
// new inputs drops it (it would read as the new selection's data). `reload()` refetches with the same deps — and so does the
// topbar ⟳ (the sync store's `tick`), so every view that loads through this hook answers the one
// app-wide refresh button instead of silently ignoring it.
export function useApi(fn, deps) {
  const [request] = useState(() => createStore(set => ({
    data: null, err: null, busy: true, dataFor: null,
    setData: update => set(state => ({ data: typeof update === 'function' ? update(state.data) : update })),
  })))
  const { data, err, busy, setData } = useStore(request)
  const [nonce, setNonce] = useState(0)
  const tick = useSync(s => s.tick)
  const inputs = useDependencyList(deps)
  const getRequest = useEffectEvent(() => fn)
  useEffect(() => {
    let live = true
    if (!request.getState().busy) request.setState({ busy: true })
    Promise.resolve().then(getRequest())
      .then(d => { if (live) request.setState({ data: d, err: null, busy: false, dataFor: inputs }) })
      .catch(e => {
        if (!live) return
        const kept = request.getState().dataFor === inputs
        request.setState(kept ? { err: cleanErr(e), busy: false } : { data: null, err: cleanErr(e), busy: false, dataFor: null })
      })
    return () => { live = false }
  }, [inputs, nonce, request, tick])
  return { data, err, busy, reload: () => setNonce(n => n + 1), setData }
}

// Debounced autosave shared by the editor views. `saver(payload)` persists; the
// returned `save(payload)` debounces it and drives a 'saving'/'saved' indicator,
// `arm()` enables saving (call it once after the initial load so hydrating state
// doesn't trigger a write). Failures surface as a toast, unless `quiet` (the saver recovers and reports itself).
export function useAutosave(saver, delay = 700, { quiet = false, ...options } = {}) {
  const [state, setState] = useState('')
  const [ctrl] = useState(() => createAutosave(saver, delay, {
    ...options,
    onState: setState,
    onError: e => { if (!quiet) toast(cleanErr(e), false) },
  }))
  useLayoutEffect(() => { ctrl.setSaver(saver) }, [ctrl, saver])
  useEffect(() => {
    ctrl.mount()
    return () => ctrl.unmount()
  }, [ctrl])
  const { save, flush, hold, release, discard, arm } = ctrl
  return { state, save, flush, hold, release, discard, arm }
}

// `value`, once it has held still for `ms`: typing in a filter box re-runs a search once, not per keystroke.
export function useDebounced(value, ms = 500) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

// Callers key requests on primitive values or object identity. Keep one list identity
// until an element changes, using the same comparison as React's effect dependencies.
function useDependencyList(values) {
  const [previous, setPrevious] = useState(() => [...values])
  if (previous.length === values.length && values.every((value, i) => Object.is(value, previous[i]))) {
    return previous
  }
  const next = [...values]
  setPrevious(next)
  return next
}

// Poll `fn` every `ms` while the window is visible, and at once when the user comes back to it
// (lib/poll.js). Restarts when `deps` change.
export function usePoll(fn, ms, deps = []) {
  const run = useEffectEvent(fn)
  const inputs = useDependencyList(deps)
  useEffect(() => startPoll(() => run(), ms), [ms, inputs])
}
