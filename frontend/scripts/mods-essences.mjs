#!/usr/bin/env node
// Build frontend/src/data/mods/essences.json: what every essence forces on every item class.
// The game keeps this in tables ggpk.exposed refuses to serve (Essences, EssenceMods), so it is
// read off poe2db's essence pages, which render those tables. Dev only, run by hand in a
// reviewed change; pages are cached under ~/.cache/arbiter/poe2db and the result is hashed into
// MANIFEST.json by sync-mods-data.mjs (run that after this).
//
//   node scripts/mods-essences.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { essenceTier } from './sync-mods-data.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'src', 'data', 'mods', 'essences.json')
const CACHE = path.join(os.homedir(), '.cache', 'arbiter', 'poe2db')
const SITE = 'https://poe2db.tw/us/'

const fetchPage = (slug) => {
  const p = path.join(CACHE, `${slug}.html`)
  if (!fs.existsSync(p) || !fs.statSync(p).size) {
    fs.mkdirSync(CACHE, { recursive: true })
    execFileSync('curl', ['-sSL', '--fail', '-A', 'Mozilla/5.0', '-o', p, SITE + slug])
  }
  return fs.readFileSync(p, 'utf8')
}

const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
const textLines = (html) => unescape(html.replace(/<[^>]+>/g, '\n')).split('\n').map(l => l.trim()).filter(Boolean)
const clean = (t) => t.replace(/\s+,/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+%/g, '%').replace(/\s*—\s*/g, '–').replace(/\s+/g, ' ').trim()

// The essence's table: Class | Modifier | Pre/Suf | Required Level.
export function parseEssence(html, name) {
  const lines = textLines(html)
  const h = lines.indexOf('Required Level')
  if (h < 0) throw new Error(`${name}: no modifier table`)
  const rows = []
  let cur = null
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l === 'Prefix' || l === 'Suffix' || l === 'Implicit') {
      const lvl = /^\d+$/.test(lines[i + 1] || '') ? Number(lines[i + 1]) : null
      rows.push({ class: cur[0], text: clean(cur.slice(1).join(' ')), affix: l.toLowerCase(), level: lvl })
      if (lvl !== null) i++
      cur = null
      continue
    }
    if (cur === null) { if (!/^[A-Z][A-Za-z ]+s$/.test(l) && l !== 'Foci') break; cur = [l] } else cur.push(l)
  }
  return rows
}

export function build() {
  const list = fetchPage('Stackable_Currency')
  const pages = [...new Set([...list.matchAll(/href="([A-Za-z_]*Essence_of_[A-Za-z_]+)"><img[^>]*\/>((?:Lesser |Greater |Perfect )?Essence of [A-Za-z ]+)<\/a>/g)].map(m => `${m[1]}\u0000${m[2]}`))]
    .map(s => s.split('\u0000')).sort((a, b) => (a[1] < b[1] ? -1 : 1))
  const essences = pages.map(([slug, name]) => ({ name, tier: essenceTier(name), rows: parseEssence(fetchPage(slug), name) }))
  fs.writeFileSync(OUT, JSON.stringify({ essences }) + '\n')
  console.log(`${essences.length} essences, ${essences.reduce((s, e) => s + e.rows.length, 0)} class rows`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) build()
