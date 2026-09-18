// Pins frontend/src/lib/color.js: hex ⇄ OKLab/OKLCH round trips, mixing, and the WCAG contrast
// ratio (checked against published reference values). Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'

const C = await import('../src/lib/color.js')

test('normHex accepts 3/6-digit, upper case, missing hash; rejects junk', () => {
  assert.equal(C.normHex('#ABC'), '#aabbcc')
  assert.equal(C.normHex('d4ac52'), '#d4ac52')
  assert.equal(C.normHex('#D4AC52 '), '#d4ac52')
  assert.equal(C.normHex('#d4ac5'), null)
  assert.equal(C.normHex('red'), null)
  assert.equal(C.normHex(''), null)
})

test('hex → rgb → hex and the triplet form', () => {
  assert.deepEqual(C.hexToRgb('#d4ac52'), [212, 172, 82])
  assert.equal(C.rgbToHex([212, 172, 82]), '#d4ac52')
  assert.equal(C.hexToTriplet('#d4ac52'), '212,172,82')
  assert.equal(C.rgbToHex([300, -4, 12.6]), '#ff000d')   // clamped + rounded
})

test('OKLab reference values (Ottosson): white, and the L axis is 0..1', () => {
  const [L, a, b] = C.hexToOklab('#ffffff')
  assert.ok(Math.abs(L - 1) < 1e-3 && Math.abs(a) < 1e-3 && Math.abs(b) < 1e-3, `white → ${[L, a, b]}`)
  const [Lk] = C.hexToOklab('#000000')
  assert.ok(Math.abs(Lk) < 1e-6)
  // Ottosson's published sRGB red: L≈0.628 a≈0.225 b≈0.126
  const [Lr, ar, br] = C.hexToOklab('#ff0000')
  assert.ok(Math.abs(Lr - 0.628) < 0.002 && Math.abs(ar - 0.225) < 0.002 && Math.abs(br - 0.126) < 0.002, `red → ${[Lr, ar, br]}`)
})

test('hex → oklab → hex and hex → oklch → hex round-trip every token-like colour exactly', () => {
  const samples = ['#0f1116', '#1b1f28', '#ece8dd', '#d4ac52', '#6fce9f', '#e07a68', '#7fb4d9', '#b39ddb', '#efd9b8', '#9a4f0f', '#ff9a3c', '#9be3f4', '#f5738a', '#808080', '#000000', '#ffffff']
  for (const h of samples) {
    assert.equal(C.oklabToHex(C.hexToOklab(h)), h, `oklab ${h}`)
    assert.equal(C.oklchToHex(C.hexToOklch(h)), h, `oklch ${h}`)
  }
})

test('oklch: hue is in [0,360) and grey has zero chroma', () => {
  const [, c, h] = C.hexToOklch('#808080')
  assert.ok(c < 1e-4 && h === 0)
  for (const x of ['#ff0000', '#00ff00', '#0000ff', '#d4ac52']) { const [, , hh] = C.hexToOklch(x); assert.ok(hh >= 0 && hh < 360) }
})

test('out-of-gamut oklch is brought in by shrinking chroma, keeping lightness', () => {
  const hex = C.oklchToHex([0.5, 0.4, 30])          // far outside sRGB
  const [L, c] = C.hexToOklch(hex)
  assert.ok(Math.abs(L - 0.5) < 0.01, `L kept ${L}`)
  assert.ok(c < 0.4)
})

test('mix is an OKLab straight line: endpoints exact, midpoint between them in lightness', () => {
  assert.equal(C.mix('#1b1f28', '#ece8dd', 0), '#1b1f28')
  assert.equal(C.mix('#1b1f28', '#ece8dd', 1), '#ece8dd')
  const mid = C.lightness(C.mix('#1b1f28', '#ece8dd', 0.5))
  const expect = (C.lightness('#1b1f28') + C.lightness('#ece8dd')) / 2
  assert.ok(Math.abs(mid - expect) < 0.005, `${mid} vs ${expect}`)
})

test('adjustL / withL move only lightness', () => {
  const [L0, c0, h0] = C.hexToOklch('#d4ac52')
  const [L1, c1, h1] = C.hexToOklch(C.adjustL('#d4ac52', 0.05))
  assert.ok(Math.abs(L1 - L0 - 0.05) < 0.005 && Math.abs(c1 - c0) < 0.01 && Math.abs(h1 - h0) < 1)
  assert.ok(Math.abs(C.lightness(C.withL('#d4ac52', 0.4)) - 0.4) < 0.005)
})

test('WCAG contrast matches published values', () => {
  assert.ok(Math.abs(C.contrast('#000000', '#ffffff') - 21) < 1e-9)
  assert.ok(Math.abs(C.contrast('#ffffff', '#ffffff') - 1) < 1e-9)
  assert.ok(Math.abs(C.contrast('#777777', '#ffffff') - 4.48) < 0.01)   // the classic just-under-AA grey
  assert.ok(Math.abs(C.contrast('#ff0000', '#ffffff') - 4.0) < 0.01)
  // Symmetric, and the Vault ink/panel pair the linter demands ≥ 7:1 on.
  assert.equal(C.contrast('#1b1f28', '#ece8dd'), C.contrast('#ece8dd', '#1b1f28'))
  assert.ok(C.contrast('#ece8dd', '#1b1f28') >= 7)
})

test('ensureContrast leaves a passing pair alone and lifts a failing one just over the bar', () => {
  assert.equal(C.ensureContrast('#ece8dd', '#1b1f28', 7), '#ece8dd')
  const fixed = C.ensureContrast('#777777', '#ffffff', 4.5)
  const r = C.contrast(fixed, '#ffffff')
  assert.ok(r >= 4.5 && r < 5.2, `ratio ${r} (${fixed})`)
  assert.ok(C.luminance(fixed) < C.luminance('#777777'), 'moved away from the white background')
  // A colour that can never pass at its chroma goes achromatic to the extreme.
  assert.equal(C.ensureContrast('#808080', '#808080', 21), '#ffffff')
})

test('deltaE is 0 for identical colours and grows with distance', () => {
  assert.equal(C.deltaE('#d4ac52', '#d4ac52'), 0)
  assert.ok(C.deltaE('#d4ac52', '#d6ae54') < C.deltaE('#d4ac52', '#7fb4d9'))
})

test('isLight splits the presets the way the linter reads them', () => {
  assert.equal(C.isLight('#efd9b8'), true)    // divinity
  assert.equal(C.isLight('#0f1116'), false)   // vault
})
