import { sleep } from './retry.js'

const writers = new Map()

export function registerFlush(write, { onHide = false } = {}) {
  writers.set(write, onHide)
  return () => writers.delete(write)
}

async function flushPass(failed, hide = false) {
  const results = await Promise.all([...writers].map(async ([write, onHide]) => {
    if (hide && !onHide) return null
    try { return (await write(failed.has(write))) === false ? write : null }
    catch { return write }
  }))
  return new Set(results.filter(Boolean))
}

export const flushOnHide = () => flushPass(new Set(), true)

export async function flushForQuit() {
  let expired = false, timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { expired = true; resolve(false) }, 900)
  })
  const finish = async () => {
    let failed = await flushPass(new Set())
    for (const ms of [100, 250]) {
      if (!failed.size || expired) break
      await sleep(ms)
      if (!expired) failed = await flushPass(failed)
    }
    return !failed.size
  }
  try { return await Promise.race([finish(), deadline]) }
  finally { clearTimeout(timer) }
}
