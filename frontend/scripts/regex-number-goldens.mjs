#!/usr/bin/env node
// Goldens for the number-to-regex module, produced by the reference implementation's OWN code (dev only). The
// upstream sources are fetched into ~/.cache at a pinned commit, transpiled in memory and run
// over the whole input space plus seeded fuzz inputs; only the output strings are written, to
// frontend/test/goldens/regex-number.json. Nothing of upstream enters the repo.
//
//   node scripts/regex-number-goldens.mjs            # pinned commit
//   node scripts/regex-number-goldens.mjs --commit <sha>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'test', 'goldens', 'regex-number.json')
const REPO = 'veiset/poe.re'
const PINNED = 'c38d7b7e86f7575d24bf7dffc453865efc0eede8'   // master, 2026-09-21
const FILES = ['shared/core/regex/GenerateNumberRegex.ts', 'poe/src/utils/regex/GeneratePriceRangeRegex.ts', 'shared/core/PriceRange.ts']

const args = process.argv.slice(2)
const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : PINNED
const cache = path.join(os.homedir(), '.cache', 'arbiter', 'poere', commit)
const esbuild = createRequire(path.resolve(HERE, '..', '..', 'desktop', 'package.json'))('esbuild')

async function fetchUpstream() {
  fs.mkdirSync(cache, { recursive: true })
  for (const f of FILES) {
    const local = path.join(cache, f)
    if (fs.existsSync(local)) continue
    fs.mkdirSync(path.dirname(local), { recursive: true })
    execFileSync('curl', ['-fsSL', '--max-time', '30', '-o', local, `https://raw.githubusercontent.com/${REPO}/${commit}/${f}`], { stdio: 'inherit' })
  }
}

// One ESM module from the three TS files, aliases resolved, types stripped.
async function loadUpstream() {
  const src = (f) => fs.readFileSync(path.join(cache, f), 'utf8')
  const price = src(FILES[2])
  const number = src(FILES[0])
  const range = src(FILES[1]).replace(/import \{normalizePriceRange\} from "@shared\/core\/PriceRange";?\n/, '')
  const ts = [price, number, range].join('\n')
  const { code } = await esbuild.transform(ts, { loader: 'ts', format: 'esm' })
  const tmp = path.join(cache, 'upstream-number.mjs')
  fs.writeFileSync(tmp, code)
  return import(pathToFileURL(tmp).href)
}

// A small seeded generator so the fuzz inputs are the same on every run.
function rng(seed) {
  let a = seed >>> 0
  const next = () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return { int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)] }
}

await fetchUpstream()
const U = await loadUpstream()
const r = rng(7)
const junk = ['', 'abc', '+', '%', ' ', '-']
const wrap = (n) => r.pick([`${n}`, `+${n}%`, ` ${n} `, `${n}abc`, `-${n}`, `${junk[r.int(0, junk.length - 1)]}${n}`])

// The grids are stored positionally (minimumGrid[round10][n], rangeGrid[round10][lo][hi]); the
// fuzz cases carry their inputs.
const minimumGrid = [false, true].map(round10 => Array.from({ length: 1000 }, (_, n) => U.generateNumberRegex(String(n), round10)))
const minimum = []
for (let i = 0; i < 1500; i++) { const v = wrap(r.int(0, 1200)); const round10 = r.int(0, 1) === 1; minimum.push({ in: v, round10, out: U.generateNumberRegex(v, round10) }) }
for (const v of ['', 'abc', '1234', '0', '00', '007']) for (const round10 of [false, true]) minimum.push({ in: v, round10, out: U.generateNumberRegex(v, round10) })

const rangeGrid = [false, true].map(round10 => Array.from({ length: 100 }, (_, lo) => Array.from({ length: 100 }, (_, hi) => U.generateNumberRangeRegex(String(lo), String(hi), round10))))
const range = []
for (let i = 0; i < 1500; i++) { const a = wrap(r.int(0, 150)), b = wrap(r.int(0, 150)); const round10 = r.int(0, 1) === 1; range.push({ min: a, max: b, round10, out: U.generateNumberRangeRegex(a, b, round10) }) }

const price = []
const edges = [0, 1, 2, 5, 9, 10, 11, 19, 20, 25, 50, 99, 100, 101, 110, 123, 150, 199, 200, 250, 500, 899, 900, 999]
for (const cur of ['exalted', 'divine', 'chaos']) for (const lo of edges) for (const hi of edges) price.push({ min: String(lo), max: String(hi), currency: cur, out: U.generatePriceRangeRegex(String(lo), String(hi), cur) })
for (let i = 0; i < 2000; i++) { const a = r.pick(['', String(r.int(-50, 1200)), wrap(r.int(0, 999))]), b = r.pick(['', String(r.int(-50, 1200)), wrap(r.int(0, 999))]); price.push({ min: a, max: b, currency: 'exalted', out: U.generatePriceRangeRegex(a, b, 'exalted') }) }

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ upstream: REPO, commit, files: FILES, minimumGrid, minimum, rangeGrid, range, price }) + '\n')
console.log(`wrote ${OUT}: ${minimumGrid[0].length * 2 + minimum.length} minimum, ${rangeGrid[0].length ** 2 * 2 + range.length} range, ${price.length} price cases from ${REPO}@${commit.slice(0, 7)}`)
