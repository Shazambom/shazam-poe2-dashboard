// The app's bounded retry: an operation that failed is tried again after each wait in `delays` (a few
// growing waits, never forever), and the first success is returned. Once every attempt has failed, the
// last error is thrown. `onFail` hears every failure (for the local diagnostic); `stop()` returning true
// (the view went away) ends the retries quietly: the result then never settles.
export const RETRY_MS = [1000, 4000, 15000]
export const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

export async function withRetry(fn, { delays = RETRY_MS, onFail, stop } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      onFail?.(e)
      if (attempt >= delays.length) throw e
      await sleep(delays[attempt])
      if (stop?.()) return new Promise(() => {})
    }
  }
}
