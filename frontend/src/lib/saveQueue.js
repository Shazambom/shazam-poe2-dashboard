import { registerFlush } from './quitFlush.js'
import { ignoredError } from './ignoredError.js'
import { withRetry } from './retry.js'

const retained = new WeakSet()
export const retainedByWriter = error => retained.has(error)

export function createSaveQueue(write, { publish, acknowledge, delays } = {}) {
  const pending = new Map()
  let failed = {}, generation = 0, tail = Promise.resolve(), active = null

  const overlay = saved => {
    let shown = saved
    if (saved) for (const [key, entry] of pending) {
      if (Object.is(saved[key], entry.value)) continue
      if (shown === saved) shown = { ...saved }
      shown[key] = entry.value
    }
    return shown
  }

  const send = (patch, current, retry) => {
    const attempt = tail.then(async () => {
      if (retry && generation !== current) return
      const sent = { ...failed, ...patch }
      let result
      try { result = await write(sent) }
      catch (error) {
        failed = sent
        if (error instanceof Object) retained.add(error)
        publish?.()
        throw error
      }
      failed = {}
      for (const key of Object.keys(sent)) {
        if (pending.get(key)?.generation <= current) pending.delete(key)
      }
      acknowledge?.(result)
      return result
    })
    active = attempt
    const settled = () => { if (active === attempt) active = null }
    tail = attempt.then(settled, settled)
    return attempt
  }

  const save = (patch, optimistic = false) => {
    const current = ++generation
    for (const [key, value] of Object.entries(patch)) pending.set(key, { generation: current, value })
    if (optimistic) publish?.()
    const first = send(patch, current, false)
    let attempt = 0
    const recovered = withRetry(() => attempt++ ? send({}, current, true) : first, { delays })
    recovered.catch(() => ignoredError('save retries exhausted'))
    return optimistic ? recovered : first
  }

  registerFlush(() => active ?? (pending.size ? save({}) : true))
  return { overlay, save }
}
