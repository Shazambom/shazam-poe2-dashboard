// A value read once on first use, for data the trade code loads from disk (EE2's catalogues).
'use strict'

/**
 * A function that answers `load()`'s promise: run on the first call, then the same promise for every call
 * after, so callers that overlap share the one read. A load that fails rejects for the callers that shared it
 * and is forgotten, so the next call loads again.
 * @template T
 * @param {() => Promise<T>} load
 * @returns {() => Promise<T>}
 */
function lazyAsync(load) {
  /** @type {Promise<T> | null} */
  let pending = null
  return () => {
    if (!pending) {
      const p = load()
      pending = p
      p.catch(() => { if (pending === p) pending = null })
    }
    return pending
  }
}

module.exports = { lazyAsync }
