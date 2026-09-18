// The renderer's error ring: the last MAX_ERRORS window errors, unhandled rejections and
// console.error calls (message + the first three stack frames), read back by the desktop's
// "Report a problem" packager through window.__arbiterErrors(). Installed once from main.jsx.
export const MAX_ERRORS = 100
const FRAMES = 3
const MAX_LINE = 500

const stamp = () => new Date().toISOString().slice(11, 19)
const text = (v) => {
  if (v instanceof Error) return String(v.stack || v.message || v).split('\n').slice(0, 1 + FRAMES).map(l => l.trim()).join(' | ')
  if (typeof v === 'string') return v
  try { return v === undefined ? 'undefined' : JSON.stringify(v) } catch { return String(v) }
}

export function installErrorRing(win = window, con = console) {
  const buf = []
  const push = (kind, ...parts) => {
    try {
      buf.push(`${stamp()} ${kind}: ${parts.map(text).join(' ')}`.slice(0, MAX_LINE))
      if (buf.length > MAX_ERRORS) buf.splice(0, buf.length - MAX_ERRORS)
    } catch {}
  }
  win.addEventListener('error', (e) => push('error', e?.error || e?.message || 'unknown'))
  win.addEventListener('unhandledrejection', (e) => push('unhandledrejection', e?.reason ?? 'unknown'))
  const orig = con.error
  con.error = (...args) => { push('console.error', ...args); try { orig.apply(con, args) } catch {} }
  const ring = { lines: () => buf.slice() }
  win.__arbiterErrors = ring.lines
  return ring
}
