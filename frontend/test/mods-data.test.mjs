// The tables the Mods tab ships (docs/mods-page-design.md): built by
// frontend/scripts/sync-mods-data.mjs from the RePoE PoE2 export, never hand-edited. The drift
// check fails the gate when a table or its source changed without a rebuild; the golden pools
// pin the collapse rule and the pool rule against what poe2db shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { stripMarkup, familyText, variantName, primaryTags } from '../scripts/sync-mods-data.mjs'
import { poolFor, atLevel } from '../src/lib/mods/pool.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'src', 'data', 'mods')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))

test('stripMarkup takes the printed side of the game\'s [keyword|display] markup', () => {
  assert.equal(stripMarkup('+(5-8) to [Strength|Strength]'), '+(5-8) to Strength')
  assert.equal(stripMarkup('Adds (3-4) to (5-8) [Cold] damage to [Attack|Attacks]'), 'Adds (3-4) to (5-8) Cold damage to Attacks')
  assert.equal(stripMarkup('[EnergyShield|Energy Shield]'), 'Energy Shield')
  assert.equal(stripMarkup('plain'), 'plain')
})

test('familyText replaces every number and range with # so tiers of a family share one text', () => {
  assert.equal(familyText('+(10-19) to maximum Life'), '+# to maximum Life')
  assert.equal(familyText('Adds 1 to (2-3) Cold damage to Attacks'), 'Adds # to # Cold damage to Attacks')
  assert.equal(familyText('(0.5-0.8)% of Damage Leeched as Life'), '#% of Damage Leeched as Life')
  assert.equal(familyText('+1 to Level of all Spell Skills'), '+# to Level of all Spell Skills')
  assert.equal(familyText('-(15-12)% to Fire Resistance'), '-#% to Fire Resistance')
  assert.equal(familyText('Regenerate (1-2) Life per second\n+(3-4) to maximum Life'), 'Regenerate # Life per second\n+# to maximum Life')
})

test('variantName names a pool after its class and attribute tags, else after its bases', () => {
  assert.equal(variantName('Rings', ['default', 'ring'], ['Iron Ring', 'Ruby Ring']), 'Rings')
  assert.equal(variantName('Gloves', ['armour', 'default', 'gloves', 'str_int_armour'], ['Rope Cuffs']), 'Gloves · Str/Int')
  assert.equal(variantName('Body Armours', ['armour', 'body_armour', 'default', 'str_dex_int_armour'], ['Garment']), 'Body Armours · Str/Dex/Int')
  assert.equal(variantName('Shields', ['armour', 'default', 'shield', 'str_armour', 'str_shield'], ['Tower Shield']), 'Shields · Str')
  assert.equal(variantName('Wands', ['default', 'no_chaos_spell_mods', 'wand'], ['Bone Wand', 'Offering Wand'], true), 'Wands · Bone, Offering')
  assert.equal(variantName('Wands', ['default', 'wand'], ['Attuned Wand', 'Siphoning Wand', 'Acrid Wand', 'Volatile Wand'], true), 'Wands · Acrid, Attuned, Siphoning +1')
  assert.equal(variantName('Jewels', ['default', 'jewel', 'strjewel'], ['Ruby'], true), 'Jewels · Ruby', 'a one-word base keeps its word')
  assert.equal(variantName('Waystones', ['default', 'map', 'map_key_low'], ['Waystone (Tier 1)', 'Waystone (Tier 2)'], true), 'Waystones · Low (T1–5)')
  assert.equal(variantName('Tablet', ['default', 'tower_augment_breach'], ['Breach Tablet'], true), 'Tablet · Breach')
})

test('primaryTags drops compound and bookkeeping tags and puts the rarest first', () => {
  const universe = ['elemental', 'damage', 'elemental_damage', 'fire', 'life', 'flat_life_regen', 'resource', 'energy_shield', 'dot_multi']
  const freq = new Map([['elemental', 52], ['damage', 54], ['fire', 22], ['life', 25]])
  assert.deepEqual(primaryTags(['elemental', 'damage', 'elemental_damage', 'fire'], universe, freq), ['fire', 'elemental', 'damage'])
  assert.deepEqual(primaryTags(['life', 'resource', 'flat_life_regen'], universe, freq), ['life'])
  assert.deepEqual(primaryTags(['energy_shield', 'dot_multi'], universe, freq), ['dot_multi', 'energy_shield'], 'a compound with no part in the universe stays')
  assert.deepEqual(primaryTags([], universe), [])
})

const manifest = readJson('MANIFEST.json')
const walk = (rel = '') => fs.readdirSync(path.join(DATA, rel), { withFileTypes: true }).flatMap(e => {
  const p = rel ? `${rel}/${e.name}` : e.name
  return e.isDirectory() ? walk(p) : e.name === 'MANIFEST.json' ? [] : [p]
})

test('every file under data/mods is in MANIFEST.json and hashes as recorded', () => {
  assert.deepEqual(Object.keys(manifest.files).sort(), walk().sort(), 'a file is missing from the manifest: rerun sync-mods-data.mjs')
  for (const [file, rec] of Object.entries(manifest.files)) {
    const buf = fs.readFileSync(path.join(DATA, file))
    assert.equal(sha(buf), rec.sha256, `${file} drifted from the manifest: rerun sync-mods-data.mjs`)
    assert.equal(buf.length, rec.bytes, file)
  }
  assert.ok(manifest.source && manifest.sources && Object.keys(manifest.sources).length >= 3, 'the export files are recorded with their hashes')
})

const { pools } = readJson('pools.json')
const { families } = readJson('mods.json')

test('pools: one per distinct spawn-tag set within an equipment class, named as poe2db\'s index', () => {
  const byClass = new Map()
  for (const p of pools) byClass.set(p.class, [...(byClass.get(p.class) || []), p])
  assert.equal(byClass.get('Rings').length, 1)
  assert.equal(byClass.get('Amulets').length, 1)
  assert.equal(byClass.get('Belts').length, 1)
  assert.equal(byClass.get('Sceptres').length, 1)
  for (const cls of ['Gloves', 'Boots', 'Body Armours', 'Helmets']) {
    const names = byClass.get(cls).map(p => p.name).sort()
    for (const v of ['Str', 'Dex', 'Int', 'Str/Dex', 'Str/Int', 'Dex/Int', 'Str/Dex/Int']) assert.ok(names.includes(`${cls} · ${v}`), `${cls} · ${v}`)
    assert.ok(!names.includes(cls), `${cls}: the attribute-less unique-only golden base is not a pool`)
  }
  assert.deepEqual(byClass.get('Shields').map(p => p.name).sort(), ['Shields · Str', 'Shields · Str/Dex', 'Shields · Str/Int'])
  assert.ok(byClass.get('Wands').length >= 5, 'wands split by their element exclusions')
  assert.ok(byClass.get('Wands').some(p => p.keywords.includes('Siphoning Wand') && p.name === 'Wands'))
  assert.ok(byClass.get('Wands').some(p => p.keywords.includes('Bone Wand') && p.name.startsWith('Wands · ')))
  assert.equal(new Set(pools.map(p => p.id)).size, pools.length)
  for (const p of pools) {
    assert.ok(p.id && p.name && p.class && Array.isArray(p.tags) && p.tags.length && Array.isArray(p.keywords) && p.keywords.length, p.id)
    assert.deepEqual(p.tags, [...p.tags].sort(), `${p.id}: tags sorted`)
    assert.equal(/^[a-z0-9_]+$/.test(p.id), true, p.id)
  }
  // Every other item class with a pool, in its own mod domain.
  assert.deepEqual(byClass.get('Waystones').map(p => p.name).sort(), ['Waystones · High (T11–15)', 'Waystones · Low (T1–5)', 'Waystones · Mid (T6–10)', 'Waystones · Top (T16)'])
  assert.equal(byClass.get('Tablet').length, 8)
  assert.ok(byClass.get('Tablet').some(p => p.name === 'Tablet · Breach' && p.keywords.includes('Breach Tablet')))
  assert.deepEqual(byClass.get('Jewels').map(p => p.name).sort(), ['Jewels · Diamond', 'Jewels · Emerald', 'Jewels · Ruby', 'Jewels · Sapphire', 'Jewels · Time-Lost Diamond', 'Jewels · Time-Lost Emerald', 'Jewels · Time-Lost Ruby', 'Jewels · Time-Lost Sapphire'])
  assert.equal(byClass.get('Life Flasks').length, 1)
  assert.equal(byClass.get('Mana Flasks').length, 1)
  assert.equal(byClass.get('Charms').length, 1)
  assert.deepEqual(byClass.get('Relics').map(p => p.name).sort(), ['Relics · Amphora, Tapestry', 'Relics · Coffer, Incense, Vase', 'Relics · Seal, Urn'])
  assert.equal(byClass.has('Sanctified Relics'), false, 'no mod keys on a sanctified relic')
  assert.equal(byClass.get('Expedition Logbooks').length, 1)
  assert.ok(byClass.get('Expedition Logbooks')[0].tags.includes('expedition_atoll_remnant_logbook'), 'a logbook rolls its areas\' mods')
  const domains = Object.fromEntries(pools.map(p => [p.class, p.domain]))
  assert.equal(domains.Rings, 'item'); assert.equal(domains.Jewels, 'misc'); assert.equal(domains['Life Flasks'], 'flask'); assert.equal(domains.Charms, 'flask')
  assert.equal(domains.Relics, 'sanctum_relic'); assert.equal(domains.Waystones, 'area'); assert.equal(domains.Tablet, 'tablet'); assert.equal(domains['Expedition Logbooks'], 'expedition_relic')
})

test('mods: item-domain prefix and suffix families with tiers, no markup, # in the family text', () => {
  assert.ok(families.length > 250, families.length)
  assert.ok(families.some(f => f.affix === 'corrupted'), 'Vaal corruption implicits are in')
  assert.ok(families.some(f => f.affix === 'enchant'), 'Vaal corruption upgrades are in')
  assert.ok(families.some(f => f.domain === 'desecrated'), 'bone mods are in')
  for (const d of ['misc', 'flask', 'sanctum_relic', 'area', 'tablet', 'expedition_relic']) assert.ok(families.some(f => f.domain === d), d)
  assert.equal(new Set(families.map(f => f.id)).size, families.length)
  const tierIds = new Set()
  for (const f of families) {
    assert.ok(['prefix', 'suffix', 'corrupted', 'enchant'].includes(f.affix), f.id)
    assert.ok(['item', 'desecrated', 'misc', 'flask', 'sanctum_relic', 'area', 'tablet', 'expedition_relic'].includes(f.domain), f.id)
    if (f.domain === 'desecrated') assert.ok(f.tiers.some(t => t.weights.some(([tag, w]) => w > 0 && ['ulaman_mod', 'amanamu_mod', 'kurgal_mod', 'breach_desecration'].includes(tag))), `${f.id}: a desecrated family keys on a bone or the breach set`)
    assert.ok(f.id.startsWith(f.affix + ':' + f.group), f.id)
    assert.equal(/[[\]|]/.test(f.text), false, f.text)
    assert.ok(f.text.includes('#') || f.tiers.length === 1, `${f.id}: ${f.text}`)
    assert.ok(Array.isArray(f.tags), f.id)
    for (const t of f.tags) assert.ok(!['resource', 'drop', 'elemental_damage', 'fire_resistance', 'flat_life_regen'].includes(t), `${f.id} carries the pruned tag ${t}`)
    assert.ok(f.tiers.length >= 1, f.id)
    for (const t of f.tiers) {
      assert.ok(t.id && t.name !== undefined && Number.isInteger(t.ilvl) && t.text && Array.isArray(t.weights), `${f.id}/${t.id}`)
      assert.equal(/[[\]|]/.test(t.text), false, t.text)
      assert.ok(t.weights.some(([, w]) => w > 0), `${t.id} never rolls anywhere`)
      assert.ok(!tierIds.has(t.id), `${t.id} belongs to two families`)
      tierIds.add(t.id)
    }
    const lv = f.tiers.map(t => t.ilvl)
    assert.deepEqual(lv, [...lv].sort((a, b) => b - a), `${f.id}: tiers best first`)
  }
})

test('golden pools: Rings and a Siphoning Wand reproduce poe2db\'s families and tier counts', () => {
  const ring = poolFor(pools.find(p => p.id === 'ring'), families)
  const life = ring.prefix.find(f => f.text === '+# to maximum Life')
  assert.ok(life, ring.prefix.map(f => f.text).join(' / '))
  assert.equal(life.tiers.length, 8)
  assert.deepEqual(life.tiers.map(t => [t.tier, t.name, t.ilvl]), [[1, 'Virile', 54], [2, 'Rotund', 46], [3, 'Robust', 38], [4, 'Stout', 33], [5, 'Stalwart', 24], [6, 'Sanguine', 16], [7, 'Healthy', 6], [8, 'Hale', 1]])
  assert.equal(life.tiers[0].text, '+(100–119) to maximum Life')
  const mana = ring.prefix.find(f => f.text === '+# to maximum Mana')
  assert.equal(mana.tiers.length, 12)
  assert.ok(ring.suffix.find(f => f.text === '+# to Strength').tiers.length === 8)
  assert.ok(ring.suffix.some(f => f.text === '+#% to Fire Resistance'))
  // poe2db's Rings calc at Max iLvL 50: Life 7 of 8 tiers; at Min iLvL 60 (strict here): Life 0, Mana 4.
  const at50 = atLevel(ring, 50, 0)
  assert.equal(at50.prefix.rows.find(r => r.family === life).k, 7)
  const floor60 = atLevel(ring, 100, 60)
  assert.equal(floor60.prefix.rows.find(r => r.family === life).k, 0)
  assert.equal(floor60.prefix.rows.find(r => r.family === mana).k, 4)

  // poe2db's Wands calc: 7 prefix and 13 suffix mod groups, the 40-tier group being the five
  // "#% increased <element> Damage" texts; here a row is one text, so those are five rows of 8.
  const wandPool = pools.find(p => p.keywords.includes('Siphoning Wand'))
  const wand = poolFor(wandPool, families)
  const groups = (fs) => new Set(fs.map(f => families.find(x => x.id === f.id).group)).size
  assert.equal(groups(wand.prefix), 7, wand.prefix.map(f => f.text).join(' / '))
  assert.equal(groups(wand.suffix), 13, wand.suffix.map(f => f.text).join(' / '))
  assert.equal(wand.prefix.length, 11)
  assert.deepEqual(wand.prefix.map(f => f.tiers.length).sort((a, b) => b - a), [11, 8, 8, 8, 8, 8, 8, 7, 6, 6, 6])
  const elements = wand.prefix.filter(f => /^#% increased (Fire|Cold|Lightning|Chaos|Spell Physical) Damage$/.test(f.text))
  assert.equal(elements.length, 5)
  assert.equal(elements.reduce((s, f) => s + f.tiers.length, 0), 40)
})

test('golden pools: waystone bands, a jewel, a tablet and a flask have their own families', () => {
  const low = poolFor(pools.find(p => p.name === 'Waystones · Low (T1–5)'), families)
  const top = poolFor(pools.find(p => p.name === 'Waystones · Top (T16)'), families)
  assert.ok(low.prefix.length + low.suffix.length >= 20, 'waystone mods')
  assert.ok(top.prefix.some(f => f.text.includes('Monster Damage')))
  assert.notDeepEqual(low.prefix.map(f => f.tiers[0].id), top.prefix.map(f => f.tiers[0].id), 'a band has its own tiers')
  const ruby = poolFor(pools.find(p => p.keywords.includes('Ruby') && p.class === 'Jewels'), families)
  assert.ok(ruby.prefix.length + ruby.suffix.length >= 20, ruby.prefix.length)
  const breach = poolFor(pools.find(p => p.keywords.includes('Breach Tablet')), families)
  assert.ok(breach.prefix.length + breach.suffix.length >= 5)
  assert.ok(breach.prefix.concat(breach.suffix).some(f => /Breach/.test(f.text)), breach.suffix.map(f => f.text).join(' / '))
  const life = poolFor(pools.find(p => p.class === 'Life Flasks'), families)
  assert.ok(life.prefix.length >= 3 && life.suffix.length >= 3)
})

test('invariants over every shipped pool: chances sum to 1, k is monotone in both edges, bands are contiguous', () => {
  const FLOORS = [0, 1, 35, 40, 44, 50, 70, 82, 100]
  for (const def of pools) {
    const pool = poolFor(def, families)
    assert.ok(pool.prefix.length + pool.suffix.length > 0, `${def.id} has no families`)
    let prev = null
    for (let L = 1; L <= 100; L++) {
      const cur = atLevel(pool, L, 0)
      for (const affix of ['prefix', 'suffix']) {
        const { rows, total } = cur[affix]
        if (total > 0) assert.ok(Math.abs(rows.reduce((s, r) => s + r.chance, 0) - 1) < 1e-9, `${def.id} ${affix} L=${L}`)
        else assert.ok(rows.every(r => r.chance === null))
        if (prev) for (const [i, r] of rows.entries()) assert.ok(r.k >= prev[affix].rows[i].k, `${def.id} ${affix} k fell from L=${L - 1} to ${L}`)
        for (const r of rows) {
          assert.equal(r.k, r.tiers.filter(t => t.state === 'in').length)
          assert.equal(r.k, r.tiers.filter(t => t.ilvl <= L).length, 'k is exactly the count in the window')
          const states = r.tiers.map(t => t.state).join(',')
          assert.equal(/in,above|below,in|below,above/.test(states), false, `${def.id} ${r.family.id} L=${L}: ${states}`)
        }
      }
      prev = cur
    }
    let prevF = null
    for (const F of FLOORS) {
      const cur = atLevel(pool, 82, F)
      for (const affix of ['prefix', 'suffix']) {
        for (const [i, r] of cur[affix].rows.entries()) {
          assert.equal(r.k, r.tiers.filter(t => F <= t.ilvl && t.ilvl <= 82).length)
          if (prevF) assert.ok(r.k <= prevF[affix].rows[i].k, `${def.id} ${affix} k rose when the floor rose to ${F}`)
        }
      }
      prevF = cur
    }
    assert.equal(atLevel(pool, 40, 60).prefix.total + atLevel(pool, 40, 60).suffix.total, 0)
  }
})
