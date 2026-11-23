// Pure Client.txt auto-timer state machine tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as sc from '../src/lib/stratcalc.js'
import {
  createAutoTimerState,
  classifyZone,
  applyClientLogEvent,
  noteManualPause,
  noteManualResume,
} from '../src/lib/stratAutoTimer.js'

function docWithStrat(overrides = {}) {
  let d = sc.blankDoc()
  d = sc.newStrat(d, { id: 's1', name: 'Strat 1', now: 1000 })
  if (Object.keys(overrides).length) {
    d = sc.edit(d, 's1', s => ({ ...s, ...overrides }), 1000)
  }
  return d
}

test('classifyZone identifies hideouts, safe towns/refuges, and combat zones accurately', () => {
  // Hideouts
  assert.equal(classifyZone('Limestone Hideout'), 'safe')
  assert.equal(classifyZone('Canal Hideout', 'HideoutCanal'), 'safe')
  assert.equal(classifyZone('Hideout'), 'safe')
  assert.equal(classifyZone('Some Custom Place', 'HideoutShrine'), 'safe')

  // Known PoE 2 towns / hubs / refuges / encampments
  for (const z of [
    'The Ziggurat Refuge',
    'Clearfell Encampment',
    'Ardura Caravan',
    'The Ardura Caravan',
    'Ziggurat Encampment',
    'Kingsmarch',
    "The Hooded One's Camp",
  ]) {
    assert.equal(classifyZone(z), 'safe', `expected safe: ${z}`)
  }
  assert.equal(classifyZone('Unknown Hub', 'G1_town'), 'safe')
  assert.equal(classifyZone('Unknown Hub', 'Endgame_Town'), 'safe')
  assert.equal(classifyZone('Unknown Hub', 'ZigguratRefuge'), 'safe')
  assert.equal(classifyZone('Unknown Hub', 'ClearfellEncampment'), 'safe')
  assert.equal(classifyZone('Unknown Hub', 'ArduraCaravan'), 'safe')

  // Combat zones (including Ogham Village and Map* areas)
  for (const [z, id] of [
    ['Crypt', 'MapCrypt'],
    ['Savannah', 'MapSavannah'],
    ['Ogham Village', 'G1_5'],
    ['Ogham Village', null],
    ['Trial of the Sekhemas', 'Sanctum_1'],
    ['Ghost Town', 'MapGhostTown'],
  ]) {
    assert.equal(classifyZone(z, id), 'combat', `expected combat: ${z} (${id})`)
  }
})

test('entering a combat zone resumes the clock and increments maps.count once per unique seed', () => {
  let state = createAutoTimerState()
  let doc = docWithStrat()

  // 1. area-gen followed by zone entry
  let r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '111', ts: 100 }, doc, 10_000)
  assert.equal(r.doc, doc, 'area-gen alone does not mutate doc')
  state = r.state

  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 102 }, doc, 12_000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'resume-and-count')
  assert.equal(sc.activeStrat(doc).maps.count, 1)
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  assert.equal(sc.activeStrat(doc).timer.startedAt, 12_000)

  // 2. Portal to hideout -> pauses timer, preserves elapsed
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 162 }, doc, 72_000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'pause')
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)
  assert.equal(sc.activeStrat(doc).timer.elapsedMs, 60_000)
  assert.equal(sc.activeStrat(doc).maps.count, 1)

  // 3. Re-enter SAME map via portal (no area-gen) -> resumes clock WITHOUT incrementing maps.count
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 180 }, doc, 90_000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'resume')
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  assert.equal(sc.activeStrat(doc).maps.count, 1, 'portal re-entry must NOT double-count map')

  // 4. Even if duplicate area-gen with same seed arrives -> still does not double-count
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 200 }, doc, 110_000)
  state = r.state; doc = r.doc
  r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '111', ts: 210 }, doc, 120_000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 211 }, doc, 121_000)
  state = r.state; doc = r.doc
  assert.equal(sc.activeStrat(doc).maps.count, 1, 'same seed never double-counted')
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)

  // 5. Open a SECOND Crypt map with a NEW seed -> counts +1
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 240 }, doc, 150_000)
  state = r.state; doc = r.doc
  r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '222', ts: 250 }, doc, 160_000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 252 }, doc, 162_000)
  doc = r.doc
  assert.equal(r.action, 'resume-and-count')
  assert.equal(sc.activeStrat(doc).maps.count, 2, 'new seed increments maps.count even with same zone name')
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
})

test('seedless fallback counts once per new combat zone name and skips same-zone portal re-entry', () => {
  let state = createAutoTimerState()
  let doc = docWithStrat()

  // First combat zone without area-gen
  let r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 10 }, doc, 10_000)
  state = r.state; doc = r.doc
  assert.equal(sc.activeStrat(doc).maps.count, 1)
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)

  // Hideout -> pause
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Canal Hideout', ts: 20 }, doc, 20_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)

  // Back to Crypt -> resume, no +1
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 30 }, doc, 30_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  assert.equal(sc.activeStrat(doc).maps.count, 1)

  // Hideout -> pause, then different combat zone Savannah -> +1
  r = applyClientLogEvent(state, { type: 'zone', zone: 'The Ziggurat Refuge', ts: 40 }, doc, 40_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)

  r = applyClientLogEvent(state, { type: 'zone', zone: 'Savannah', ts: 50 }, doc, 50_000)
  doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  assert.equal(sc.activeStrat(doc).maps.count, 2)
})

test('afk-on pauses active timer; afk-off resumes only if AFK paused an active combat run (without double-counting)', () => {
  // Outside combat (or before entering any combat zone): afk-on pauses a manually started timer, afk-off does NOT restart it.
  let state = createAutoTimerState()
  let doc = docWithStrat({ timer: { startedAt: 1000, elapsedMs: 0 } })

  let r = applyClientLogEvent(state, { type: 'afk-on', ts: 50 }, doc, 50_000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'pause')
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)
  assert.equal(sc.activeStrat(doc).timer.elapsedMs, 49_000)

  const pausedDoc = doc
  r = applyClientLogEvent(state, { type: 'afk-off', ts: 60 }, doc, 60_000)
  assert.equal(r.doc, pausedDoc, 'afk-off never starts timer outside combat')
  assert.equal(sc.running(sc.activeStrat(r.doc).timer), false)

  // Inside a combat zone: afk-on pauses, afk-off auto-resumes without incrementing maps.count
  state = createAutoTimerState()
  doc = docWithStrat()
  r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '301', ts: 10 }, doc, 10_000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 11 }, doc, 11_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  assert.equal(sc.activeStrat(doc).maps.count, 1)

  r = applyClientLogEvent(state, { type: 'afk-on', ts: 31 }, doc, 31_000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'pause')
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)
  assert.equal(sc.activeStrat(doc).timer.elapsedMs, 20_000)

  r = applyClientLogEvent(state, { type: 'afk-off', ts: 51 }, doc, 51_000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'resume')
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  assert.equal(sc.activeStrat(doc).timer.startedAt, 51_000)
  assert.equal(sc.activeStrat(doc).maps.count, 1, 'afk-off inside map must NOT double-count')

  // If user enters hideout while AFK, afk-off in hideout does NOT start the timer
  r = applyClientLogEvent(state, { type: 'afk-on', ts: 61 }, doc, 61_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 65 }, doc, 65_000)
  state = r.state; doc = r.doc
  r = applyClientLogEvent(state, { type: 'afk-off', ts: 70 }, doc, 70_000)
  assert.equal(r.action, 'none')
  assert.equal(sc.running(sc.activeStrat(r.doc).timer), false, 'afk-off in hideout must stay paused')

  // If user manually paused in combat before going AFK, afk-off respects manual pause
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 75 }, doc, 75_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)
  doc = sc.toggle(doc, 's1', 80_000)
  state = noteManualPause(state)
  r = applyClientLogEvent(state, { type: 'afk-on', ts: 85 }, doc, 85_000)
  state = r.state; doc = r.doc
  r = applyClientLogEvent(state, { type: 'afk-off', ts: 90 }, doc, 90_000)
  assert.equal(sc.running(sc.activeStrat(r.doc).timer), false, 'afk-off must respect manual pause')
})

test('manual pause inside a map keeps timer paused until the next distinct instance/seed', () => {
  let state = createAutoTimerState()
  let doc = docWithStrat()

  // Enter map seed 111 -> running, count 1
  let r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '111', ts: 10 }, doc, 10_000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 11 }, doc, 11_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true)

  // User manually clicks Pause inside map seed 111
  doc = sc.toggle(doc, 's1', 20_000)
  state = noteManualPause(state)
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)

  // Portal to hideout and back into SAME map seed 111 -> must STAY paused
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 25 }, doc, 25_000)
  state = r.state; doc = r.doc
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 30 }, doc, 30_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), false, 'stays paused in same map instance after manual pause')
  assert.equal(sc.activeStrat(doc).maps.count, 1)

  // Enter NEW map seed 222 -> clears manual pause, resumes timer, increments count
  r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapSavannah', seed: '222', ts: 40 }, doc, 40_000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Savannah', ts: 41 }, doc, 41_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true, 'resumes automatically on next distinct seed')
  assert.equal(sc.activeStrat(doc).maps.count, 2)

  // Manual resume clears manual pause for current instance too
  doc = sc.toggle(doc, 's1', 50_000)
  state = noteManualPause(state)
  doc = sc.toggle(doc, 's1', 55_000)
  state = noteManualResume(state)
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 60 }, doc, 60_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), false)
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Savannah', ts: 65 }, doc, 65_000)
  doc = r.doc
  assert.equal(sc.running(sc.activeStrat(doc).timer), true, 'manual resume re-enabled auto-resume for current instance')
})

test('manual time override (strat.time.on === true) is NEVER mutated', () => {
  let state = createAutoTimerState()
  const doc = docWithStrat({ time: { on: true, ms: 3_600_000 }, maps: { count: 5, price: 0, cur: 'chaos' } })

  let r = applyClientLogEvent(state, { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '999', ts: 10 }, doc, 10_000)
  state = r.state
  assert.equal(r.doc, doc)

  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 11 }, doc, 11_000)
  state = r.state
  assert.equal(r.doc, doc, 'combat entry must not mutate strat when time.on is true')
  assert.equal(sc.activeStrat(r.doc).maps.count, 5)
  assert.equal(sc.running(sc.activeStrat(r.doc).timer), false)

  r = applyClientLogEvent(state, { type: 'zone', zone: 'Limestone Hideout', ts: 15 }, doc, 15_000)
  state = r.state
  assert.equal(r.doc, doc, 'hideout entry must not mutate strat when time.on is true')

  r = applyClientLogEvent(state, { type: 'afk-on', ts: 20 }, doc, 20_000)
  assert.equal(r.doc, doc, 'afk-on must not mutate strat when time.on is true')
})

test('auto-resume preserves single-running-timer invariant across multiple strats and handles empty doc', () => {
  // Empty doc: no-op
  const empty = sc.blankDoc()
  let state = createAutoTimerState()
  const rEmpty = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 10 }, empty, 10_000)
  assert.equal(rEmpty.doc, empty)

  // Two strats: s1 running, s2 active (paused) -> entering combat starts s2 and stops s1
  let doc = sc.blankDoc()
  doc = sc.newStrat(doc, { id: 's1', name: 'Strat 1', now: 1000 })
  doc = sc.toggle(doc, 's1', 2000)
  doc = sc.newStrat(doc, { id: 's2', name: 'Strat 2', now: 3000 })
  assert.equal(doc.active, 's2')
  assert.equal(sc.running(doc.strats.find(s => s.id === 's1').timer), true)
  assert.equal(sc.running(doc.strats.find(s => s.id === 's2').timer), false)

  state = createAutoTimerState()
  const r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 5 }, doc, 5000)
  assert.equal(sc.running(r.doc.strats.find(s => s.id === 's2').timer), true)
  assert.equal(sc.running(r.doc.strats.find(s => s.id === 's1').timer), false, 'other strat stopped to keep one running clock')
  assert.equal(r.doc.strats.find(s => s.id === 's2').maps.count, 1)
})

test('Hideout / Town / AFK pauses previously running strategy even after switching active strat mid-session', () => {
  // Case 1: s1 running, user switches active to paused s2 -> Hideout pauses s1
  let doc = sc.blankDoc()
  doc = sc.newStrat(doc, { id: 's1', name: 'Strat A', now: 1000 })
  doc = sc.newStrat(doc, { id: 's2', name: 'Strat B', now: 1500 })
  doc = { ...doc, active: 's1' }
  let state = createAutoTimerState()
  let r = applyClientLogEvent(state, { type: 'area-gen', level: 81, areaId: 'MapCrypt', seed: '701', ts: 2 }, doc, 2000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Crypt', ts: 3 }, doc, 3000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(doc.strats.find(s => s.id === 's1').timer), true)

  // Switch active strat to s2 while s1 is still running, then enter Hideout
  doc = { ...doc, active: 's2' }
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Dreadnought Hideout', ts: 8 }, doc, 8000)
  state = r.state; doc = r.doc
  assert.equal(r.action, 'pause')
  assert.equal(sc.running(doc.strats.find(s => s.id === 's1').timer), false, 's1 must pause on Hideout after switching active strat to s2')
  assert.equal(doc.strats.find(s => s.id === 's1').timer.elapsedMs, 5000)

  // Case 2: s1 running, user switches active to s3 (with Override time.on === true) -> AFK still pauses s1 without touching s3
  doc = sc.newStrat(doc, { id: 's3', name: 'Overridden', now: 9000 })
  doc = sc.edit(doc, 's3', s => ({ ...s, time: { on: true, ms: 7_200_000 } }), 9000)
  doc = { ...doc, active: 's1' }
  r = applyClientLogEvent(state, { type: 'area-gen', level: 81, areaId: 'MapSavannah', seed: '702', ts: 10 }, doc, 10_000)
  state = r.state
  r = applyClientLogEvent(state, { type: 'zone', zone: 'Savannah', ts: 11 }, doc, 11_000)
  state = r.state; doc = r.doc
  assert.equal(sc.running(doc.strats.find(s => s.id === 's1').timer), true)

  doc = { ...doc, active: 's3' }
  r = applyClientLogEvent(state, { type: 'afk-on', ts: 16 }, doc, 16_000)
  assert.equal(r.action, 'pause')
  assert.equal(sc.running(r.doc.strats.find(s => s.id === 's1').timer), false, 's1 must pause on AFK even when active strat has time.on')
  assert.equal(r.doc.strats.find(s => s.id === 's3').time.ms, 7_200_000, 'overridden strat untouched')
})

