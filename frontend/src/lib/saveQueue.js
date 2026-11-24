import { registerFlush } from './quitFlush.js'
import { ignoredError } from './ignoredError.js'
import { withRetry } from './retry.js'

const retained = new WeakMap()
export const flushForFailure = error => retained.get(error)

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function mergePatch(base, patch) {
  if (Object.is(base, patch) || !record(base) || !record(patch)) return patch
  const changed = []
  for (const [key, value] of Object.entries(patch)) {
    const merged = mergePatch(base[key], value)
    if (!Object.is(merged, base[key])) changed.push([key, merged])
  }
  return changed.length ? { ...base, ...Object.fromEntries(changed) } : base
}

export function createSaveQueue(write, { publish, acknowledge, delays } = {}) {
  const pending = new Map()
  let failed = {}, generation = 0, tail = Promise.resolve(), active = null

  const overlay = saved => saved && pending.size
    ? mergePatch(saved, Object.fromEntries([...pending].map(([key, entry]) => [key, entry.value]))) : saved

  const send = (patch, current, retry) => {
    const attempt = tail.then(async () => {
      if (retry && generation !== current) return
      const sent = mergePatch(failed, patch)
      let result
      try { result = await write(sent) }
      catch (error) {
        failed = sent
        if (error instanceof Object) retained.set(error, flush)
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
    for (const [key, value] of Object.entries(patch)) pending.set(key, { generation: current, value: mergePatch(pending.get(key)?.value, value) })
    if (optimistic) publish?.()
    const first = send(patch, current, false)
    let attempt = 0
    const recovered = withRetry(() => attempt++ ? send({}, current, true) : first, { delays })
    recovered.catch(() => ignoredError('save retries exhausted'))
    return optimistic ? recovered : first
  }

  const flush = () => active ?? (pending.size ? save({}) : true)
  registerFlush(flush)
  return { overlay, save }
}
