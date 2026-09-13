import { useEffect, useRef, useState } from 'react'
import { cleanErr, toast } from './api.js'

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
