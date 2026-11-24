import { ignoredError } from './ignoredError.js'
import { registerFlush } from './quitFlush.js'
import { flushForFailure } from './saveQueue.js'
// Pure debounced autosave controller shared by useAutosave (lib/hooks.js).
// Coalesces superseded edits while a write is in flight, lets flush() report whether pending/in-flight
// saves succeeded, flushes unheld pending edits synchronously on unmount so shared queues keep FIFO order,
// and prevents stale async closures from scheduling writes after unmount.
export function createAutosave(saver, delay = 700, { onState, onError, retainFailed = true, register = true } = {}) {
  let getSaver = typeof saver === 'function' ? () => saver : () => null
  let timer = null
  let savedTimer = null
  let armed = false
  let held = false
  let unmounted = false
  let pending = null
  let due = false
  let inFlight = null
  let unmountRun = null
  let flushing = 0
  let flushFailed = false
  let failed = null, version = 0, unregister = null

  const retain = (error, payload, revision) => {
    if (retainFailed && revision === version) failed = { payload, retry: flushForFailure(error) }
  }
  const detach = () => {
    if (unmounted && !inFlight && !unmountRun && (!failed || failed.retry)) { unregister?.(); unregister = null }
  }

  const setState = (s) => { if (!unmounted) onState?.(s) }

  const run = (payload, retry) => {
    const revision = version
    let settled = false
    let p = null
    p = (async () => {
      try {
        if (retry) await retry()
        else await getSaver()?.(payload)
        if (!unmounted && !retry) {
          setState('saved')
          clearTimeout(savedTimer)
          savedTimer = setTimeout(() => setState(s => (s === 'saved' ? '' : s)), 1400)
        }
        return true
      } catch (e) {
        retain(e, payload, revision)
        if (flushing) flushFailed = true
        if (!unmounted && !retry) {
          setState('')
          onError?.(e)
        }
        return false
      } finally {
        settled = true
        if (p && inFlight === p) inFlight = null
        detach()
        if (!unmounted && !held && !flushing && pending && due) dispatchPending()
      }
    })()
    if (!settled) inFlight = p
    return p
  }

  const dispatchPending = () => {
    if (!pending) return Promise.resolve(true)
    clearTimeout(timer); timer = null
    const { payload, retry } = pending
    pending = null
    due = false
    return run(payload, retry)
  }

  const save = (payload) => {
    if (!armed || unmounted) return
    version++
    failed = null
    clearTimeout(timer); timer = null
    pending = { payload }
    due = false
    setState('saving')
    if (held) return   // kept until release()
    timer = setTimeout(() => {
      timer = null
      if (inFlight) {
        due = true     // coalesce edits while in-flight; dispatch latest once it settles
      } else {
        dispatchPending()
      }
    }, delay)
  }

  // Sends any pending edit now and waits until both it and any already in-flight save complete.
  // Resolves to false if any flushed/in-flight save rejected (including synchronous throws on due follow-ups
  // or a pending save flushed synchronously by unmount() during an active flush).
  const flush = async () => {
    if (failed && !held) { pending = failed; failed = null }
    if (!flushing) flushFailed = false
    flushing++
    let ok = true
    try {
      while (inFlight || unmountRun || (pending && !held)) {
        if (inFlight) {
          if (!(await inFlight)) ok = false
        } else if (unmountRun) {
          if (!(await unmountRun)) ok = false
        } else if (pending && !held) {
          if (!(await dispatchPending())) ok = false
        }
      }
      return ok && !flushFailed
    } finally {
      flushing--
      if (!flushing) {
        flushFailed = false
        if (!unmounted && !held && !inFlight && pending && due) dispatchPending()
      }
    }
  }

  const hold = () => {
    held = true
    clearTimeout(timer); timer = null
  }

  const release = () => {
    if (!held) return
    held = false
    if (unmounted) return
    if (pending) save(pending.payload)
  }

  const discard = () => {
    version++
    failed = null
    clearTimeout(timer); timer = null
    pending = null
    due = false
    setState('')
  }

  const unmount = () => {
    unmounted = true
    clearTimeout(timer); timer = null
    clearTimeout(savedTimer); savedTimer = null
    if (failed && !held) { pending = failed; failed = null }
    if (pending && !held) {
      const revision = version
      const { payload, retry } = pending
      pending = null
      due = false
      // Invoke saver synchronously so shared queues (settingsQueue, capitalQueue) preserve FIFO order
      // against an immediate preset write or remount waitCapital(). Track its outcome so an active
      // flush() still awaits it and observes any sync throw or async rejection.
      let p
      try {
        p = Promise.resolve(retry ? retry() : getSaver()?.(payload)).then(() => true, error => {
          retain(error, payload, revision)
          if (flushing) flushFailed = true
          return false
        })
      } catch (error) {
        retain(error, payload, revision)
        if (flushing) flushFailed = true
        p = Promise.resolve(false)
      }
      unmountRun = p
      p.finally(() => {
        if (unmountRun === p) unmountRun = null
        detach()
      }).catch(() => ignoredError('finish unmount save'))
    }
    detach()
  }

  const mount = () => { unmounted = false; if (register) unregister ??= registerFlush(flush) }

  return {
    save,
    flush,
    hold,
    release,
    discard,
    arm: () => { armed = true },
    mount,
    unmount,
    setSaver: (fn) => { getSaver = () => fn },
  }
}
