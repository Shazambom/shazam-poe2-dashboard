import { isQuitting, registerFlush } from './quitFlush.js'
import { RETRY_MS } from './retry.js'

const QUIT_RETRY_MS = [100, 250]

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const branch = value => record(value) && Object.keys(value).length > 0

function mergePatch(base, patch) {
  if (Object.is(base, patch) || !record(base) || !record(patch)) return patch
  const changed = []
  for (const [key, value] of Object.entries(patch)) {
    const merged = mergePatch(base[key], value)
    if (!Object.is(merged, base[key])) changed.push([key, merged])
  }
  return changed.length ? { ...base, ...Object.fromEntries(changed) } : base
}

function setLeaves(node, patch, generation, optimistic, allow = null, path = []) {
  for (const [key, value] of Object.entries(patch)) {
    const nextPath = [...path, key]
    if (branch(value)) {
      const existing = node.get(key)
      const child = existing instanceof Map ? existing : new Map()
      setLeaves(child, value, generation, optimistic, allow, nextPath)
      if (child.size) node.set(key, child)
    } else if (!allow || allow(nextPath)) {
      node.set(key, { value, generation, optimistic })
    }
  }
}

function getLeaf(node, path) {
  let cur = node
  for (const key of path) {
    if (!(cur instanceof Map)) return null
    cur = cur.get(key)
  }
  return cur instanceof Map ? null : cur ?? null
}

function prunePaths(node, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const existing = node.get(key)
    if (existing === undefined) continue
    if (branch(value) && existing instanceof Map) {
      prunePaths(existing, value)
      if (!existing.size) node.delete(key)
    } else {
      node.delete(key)
    }
  }
}

function toPatch(node) {
  const out = {}
  for (const [key, entry] of node) {
    out[key] = entry instanceof Map ? toPatch(entry) : entry.value
  }
  return out
}

function prune(node, predicate) {
  for (const [key, entry] of node) {
    if (entry instanceof Map) {
      prune(entry, predicate)
      if (!entry.size) node.delete(key)
    } else if (predicate(entry)) {
      node.delete(key)
    }
  }
}

function hasLeaf(node, predicate) {
  for (const entry of node.values()) {
    if (entry instanceof Map ? hasLeaf(entry, predicate) : predicate(entry)) return true
  }
  return false
}

function maxGen(node) {
  let max = 0
  for (const entry of node.values()) {
    const g = entry instanceof Map ? maxGen(entry) : entry.generation
    if (g > max) max = g
  }
  return max
}

export function createSaveQueue(write, { publish, acknowledge, delays = RETRY_MS } = {}) {
  const pending = new Map()
  const failed = new Map()
  const waiters = new Set()
  let generation = 0, tail = Promise.resolve(), active = null, lastResult

  const overlay = saved => (saved && pending.size ? mergePatch(saved, toPatch(pending)) : saved)

  const resolveWaiter = (waiter, result) => {
    if (waiter.settled) return
    waiter.settled = true
    waiters.delete(waiter)
    waiter.wake?.()
    waiter.resolve(result)
  }

  const send = (patch, current, optimistic, retry) => {
    const attempt = tail.then(async () => {
      if (retry && !failed.size) return lastResult
      const failedMax = maxGen(failed)
      const sentGen = retry ? failedMax : Math.max(failedMax, current)
      const sent = retry ? toPatch(failed) : mergePatch(toPatch(failed), patch)
      let result
      try { result = await write(sent) }
      catch (error) {
        if (!retry) {
          setLeaves(failed, patch, current, optimistic, path => getLeaf(pending, path)?.generation === current)
        }
        publish?.()
        throw error
      }
      lastResult = result
      prune(failed, e => e.generation <= sentGen)
      prune(pending, e => e.generation <= sentGen)
      acknowledge?.(result)
      for (const waiter of [...waiters]) {
        if (waiter.generation <= sentGen) resolveWaiter(waiter, result)
      }
      return result
    })
    active = attempt
    const settled = () => { if (active === attempt) active = null }
    tail = attempt.then(settled, settled)
    return attempt
  }

  const save = (patch, optimistic = false) => {
    const current = ++generation
    const hasKeys = Object.keys(patch).length > 0
    setLeaves(pending, patch, current, optimistic)
    prunePaths(failed, patch)
    for (const waiter of waiters) {
      if (waiter.hasKeys && !waiter.settled && !waiter.superseded && !hasLeaf(pending, e => e.generation === waiter.generation)) {
        waiter.superseded = true
        waiter.wake?.()
      }
    }
    if (optimistic) publish?.()

    const { promise, resolve, reject } = Promise.withResolvers()
    const waiter = {
      generation: current,
      hasKeys,
      optimistic,
      quitting: isQuitting(),
      superseded: false,
      settled: false,
      wake: null,
      resolve,
      reject,
      promise,
    }
    waiters.add(waiter)

    const run = async () => {
      const schedule = waiter.quitting ? QUIT_RETRY_MS : delays
      let lastError
      for (let i = 0; ; i++) {
        if (waiter.settled || (i > 0 && waiter.superseded)) return
        try {
          const result = await send(i === 0 ? patch : {}, current, optimistic, i > 0)
          resolveWaiter(waiter, result)
          return
        } catch (error) {
          lastError = error
          if (waiter.settled || waiter.superseded) return
          if (i >= schedule.length) break
          await new Promise(done => {
            const t = setTimeout(() => { waiter.wake = null; done() }, schedule[i])
            waiter.wake = () => { clearTimeout(t); waiter.wake = null; done() }
          })
        }
      }
      if (waiter.settled || waiter.superseded) return
      waiter.settled = true
      waiters.delete(waiter)
      if (!optimistic) {
        prune(failed, e => e.generation === current)
        prune(pending, e => e.generation === current)
        publish?.()
      }
      for (const other of [...waiters]) {
        if (other.superseded && other.generation < current
            && ![...waiters].some(w => !w.superseded && w.generation > other.generation)) {
          resolveWaiter(other, lastResult)
        }
      }
      reject(lastError)
    }

    run()
    return promise
  }

  const flush = async () => {
    if (active) {
      try { await active } catch {
        const quitWaiters = [...waiters].filter(w => w.quitting && !w.settled)
        if (quitWaiters.length) {
          await Promise.allSettled(quitWaiters.map(w => w.promise))
          return !failed.size && !pending.size
        }
        return false
      }
    }
    if (!failed.size) return true
    await send({}, generation, false, true)
    return !failed.size
  }
  registerFlush(flush)
  return { overlay, save }
}
