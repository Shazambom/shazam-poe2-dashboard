// Guarded polyfills for ES2023/ES2025 built-ins EE2 uses (it targets Chrome ≥ 101; Electron 33's
// V8 has them all). Only installed when missing, so the repo's Node 18 test runner and the
// --stdin CLI behave like the app. Ours, not vendored. Semantics follow the spec closely enough
// for EE2's uses (sets of strings, arrays of plain values).
'use strict'
const def = (proto, name, fn) => { if (!proto[name]) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true }) }
def(Array.prototype, 'toSorted', function (cmp) { return this.slice().sort(cmp) })
def(Array.prototype, 'toReversed', function () { return this.slice().reverse() })
def(Array.prototype, 'toSpliced', function (...a) { const c = this.slice(); c.splice(...a); return c })
def(Array.prototype, 'with', function (i, v) { const c = this.slice(); c[i < 0 ? c.length + i : i] = v; return c })
def(Array.prototype, 'findLast', function (fn) { for (let i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return this[i]; return undefined })
def(Array.prototype, 'findLastIndex', function (fn) { for (let i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return i; return -1 })
const S = Set.prototype
def(S, 'intersection', function (o) { const r = new Set(); for (const v of this) if (o.has(v)) r.add(v); return r })
def(S, 'union', function (o) { const r = new Set(this); for (const v of o) r.add(v); return r })
def(S, 'difference', function (o) { const r = new Set(); for (const v of this) if (!o.has(v)) r.add(v); return r })
def(S, 'symmetricDifference', function (o) { const r = new Set(this); for (const v of o) { if (r.has(v)) r.delete(v); else r.add(v) } return r })
def(S, 'isSubsetOf', function (o) { for (const v of this) if (!o.has(v)) return false; return true })
def(S, 'isSupersetOf', function (o) { for (const v of o) if (!this.has(v)) return false; return true })
def(S, 'isDisjointFrom', function (o) { for (const v of this) if (o.has(v)) return false; return true })
if (!Object.groupBy) Object.groupBy = (it, fn) => { const out = Object.create(null); let i = 0; for (const v of it) (out[fn(v, i++)] ||= []).push(v); return out }
if (!Map.groupBy) Map.groupBy = (it, fn) => { const out = new Map(); let i = 0; for (const v of it) { const k = fn(v, i++); if (!out.has(k)) out.set(k, []); out.get(k).push(v) } return out }
