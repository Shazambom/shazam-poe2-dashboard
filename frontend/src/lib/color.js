// A tiny colour utility for the custom theme builder — no deps. sRGB hex ⇄ OKLab/OKLCH, mixing in
// OKLab (perceptually even, so "15% toward ink" looks like 15% on every hue), a lightness
// nudge, gamut clamping, and the WCAG 2 contrast ratio (the same formula scripts/lint-style.mjs
// enforces on the presets). Every function takes and returns `#rrggbb` unless it says otherwise.
//
// OKLab per Björn Ottosson (https://bottosson.github.io/posts/oklab/) — the matrices below are
// his published sRGB(linear) ⇄ LMS ⇄ OKLab constants.

export function normHex(hex) {
  let h = String(hex || '').trim().toLowerCase()
  if (!h.startsWith('#')) h = '#' + h
  if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + [...h.slice(1)].map(c => c + c).join('')
  return /^#[0-9a-f]{6}$/.test(h) ? h : null
}
export const isHex = (hex) => normHex(hex) !== null

export function hexToRgb(hex) {
  const h = normHex(hex)
  if (!h) throw new Error(`bad hex ${hex}`)
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}
export function rgbToHex([r, g, b]) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
// "212,172,82" — the `--*-rgb` triplet form styles.css feeds into rgba().
export const hexToTriplet = (hex) => hexToRgb(hex).join(',')

const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const fromLinear = (c) => { c = Math.max(0, Math.min(1, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) }

export function rgbToOklab([r, g, b]) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
// Returns linear-light channels unclamped, so callers can tell in-gamut from out.
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}
export function oklabToRgb(lab) {
  return oklabToLinear(lab).map(fromLinear)
}
const inGamut = (lab) => oklabToLinear(lab).every(c => c >= -1e-4 && c <= 1 + 1e-4)

export const hexToOklab = (hex) => rgbToOklab(hexToRgb(hex))
export const oklabToHex = (lab) => rgbToHex(oklabToRgb(lab))

// OKLCH: [L 0..1, C ≥ 0, h degrees 0..360)
export function oklabToOklch([L, a, b]) {
  const C = Math.hypot(a, b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return [L, C, C < 1e-6 ? 0 : h]
}
export function oklchToOklab([L, C, h]) {
  const r = (h * Math.PI) / 180
  return [L, C * Math.cos(r), C * Math.sin(r)]
}
export const hexToOklch = (hex) => oklabToOklch(hexToOklab(hex))
// Out-of-gamut OKLCH is brought in by shrinking chroma (keeps hue and lightness — what a
// designer expects when they "brighten the gold" past what sRGB can show).
export function oklchToHex([L, C, h]) {
  L = Math.max(0, Math.min(1, L))
  let lo = 0, hi = Math.max(0, C)
  if (inGamut(oklchToOklab([L, hi, h]))) return oklabToHex(oklchToOklab([L, hi, h]))
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToOklab([L, mid, h]))) lo = mid; else hi = mid }
  return oklabToHex(oklchToOklab([L, lo, h]))
}

// Perceptual mix: t=0 → a, t=1 → b, straight line in OKLab.
export function mix(a, b, t) {
  const A = hexToOklab(a), B = hexToOklab(b)
  return oklabToHex(A.map((x, i) => x + (B[i] - x) * t))
}
// Lightness nudge in OKLCH (dL may be negative). Chroma and hue are kept; gamut clamp shrinks chroma if needed.
export function adjustL(hex, dL) {
  const [L, C, h] = hexToOklch(hex)
  return oklchToHex([L + dL, C, h])
}
export function withL(hex, L) { const [, C, h] = hexToOklch(hex); return oklchToHex([L, C, h]) }
export function withChroma(hex, C) { const [L, , h] = hexToOklch(hex); return oklchToHex([L, C, h]) }
export const lightness = (hex) => hexToOklch(hex)[0]
export const isLight = (hex) => luminance(hex) > 0.4

// WCAG 2.x relative luminance + contrast ratio (1..21). Same math as lint-style.mjs.
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// Push `fg` away from `bg` in lightness (keeping hue/chroma) until contrast(fg, bg) ≥ min.
// Returns fg unchanged when it already passes; goes as far as pure black/white if it must.
export function ensureContrast(fg, bg, min) {
  if (contrast(fg, bg) >= min) return fg
  const [L0, C, h] = hexToOklch(fg)
  const dir = luminance(fg) >= luminance(bg) ? 1 : -1
  let lo = L0, hi = dir > 0 ? 1 : 0
  if (contrast(oklchToHex([hi, C, h]), bg) < min) {
    // Even the extreme fails with this chroma — drop chroma too (a greyer, but readable, colour).
    hi = dir > 0 ? 1 : 0
    return oklchToHex([hi, 0, h])
  }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (contrast(oklchToHex([mid, C, h]), bg) >= min) hi = mid; else lo = mid
  }
  return oklchToHex([hi, C, h])
}

// Euclidean ΔE in OKLab (≈ 0.02 is a just-noticeable difference for most people).
export function deltaE(a, b) {
  const A = hexToOklab(a), B = hexToOklab(b)
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])
}
