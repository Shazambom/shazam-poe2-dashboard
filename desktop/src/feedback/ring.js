// A bounded ring of log lines: the last N, each clamped and stamped HH:MM:SS. Feeds the main-process
// and updater logs into a feedback report without keeping unbounded history around.
'use strict'

const MAX_LINE = 500

function makeRing(n, now = () => new Date()) {
  const buf = []
  const text = (v) => {
    if (typeof v === 'string') return v
    if (v instanceof Error) return String(v.stack || v.message || v)
    try { return v === undefined ? 'undefined' : JSON.stringify(v) } catch { return String(v) }
  }
  return {
    push(line) {
      try {
        buf.push(`${now().toISOString().slice(11, 19)} ${text(line).slice(0, MAX_LINE)}`)
        if (buf.length > n) buf.splice(0, buf.length - n)
      } catch {}
    },
    lines: () => buf.slice(),
    clear: () => { buf.length = 0 },
  }
}

module.exports = { makeRing, MAX_LINE }
