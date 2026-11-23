// Pure Client.txt auto-timer and map counter state machine for Stash → Strat Calculator.
//
// Consumes safe Client.txt events (area-gen, zone, afk-on, afk-off) and returns the next
// state and strat document without side effects:
//   - Hideout / Town / Refuge / AFK ON -> pauses active strat's timer.
//   - Combat zone entry -> resumes active strat's timer and increments maps.count once per
//     distinct instance seed (or once per new combat zone name when no area-gen preceded it).
//   - Re-entering the same map instance after a hideout portal trip resumes the clock without
//     double-counting maps.count.
//   - Never mutates a strat when manual time override (strat.time.on) is enabled.
//   - Respects manual pause inside the current map instance until the next distinct instance/seed.
import * as sc from './stratcalc.js'

const PENDING_GEN_TTL_MS = 180_000   // 3 min window between opening portals (area-gen) and entering
const MAX_TRACKED_SEEDS = 32

// Known PoE 2 non-combat towns / hubs / refuges / encampments (lowercase).
// Combat zones (e.g. Ogham Village, Trial of the Sekhemas) are intentionally excluded.
const SAFE_ZONES = new Set([
  'the ziggurat refuge',
  'ziggurat refuge',
  'ziggurat encampment',
  'the ziggurat encampment',
  'clearfell encampment',
  'ardura caravan',
  'the ardura caravan',
  'kingsmarch',
  "the hooded one's camp",
])

function isSafeZoneName(zoneName) {
  const z = String(zoneName ?? '').trim().toLowerCase()
  if (!z) return false
  if (z.includes('hideout')) return true
  return SAFE_ZONES.has(z)
}

function isSafeAreaId(areaId) {
  const id = String(areaId ?? '').trim()
  if (!id) return false
  if (/^hideout/i.test(id)) return true
  if (/^map/i.test(id)) return false   // endgame maps (e.g. MapCrypt, MapGhostTown) are always combat
  return /(?:^|_)town\b|town|refuge|encampment|caravan|kingsmarch/i.test(id)
}

export function classifyZone(zoneName, areaId = null) {
  if (isSafeZoneName(zoneName) || isSafeAreaId(areaId)) return 'safe'
  return 'combat'
}

export function createAutoTimerState() {
  return {
    pendingGen: null,           // { areaId, seed, level, receivedAt }
    currentInstanceKey: null,   // 'seed:<seed>' | 'zone:<name>#<seq>'
    lastCombatZone: null,       // last entered combat zone name (for seedless portal re-entry dedup)
    countedSeeds: [],           // recent counted area-gen seeds (bounded)
    manualPauseInstance: null,  // instanceKey where the user manually paused the timer
    inCombat: false,            // true while character is in a combat zone (map/area)
    pausedByAfk: false,         // true when afk-on paused an active combat timer
    instanceSeq: 0,
  }
}

export function noteManualPause(state) {
  if (!state) return state
  const next = state.pausedByAfk ? { ...state, pausedByAfk: false } : state
  if (!next.currentInstanceKey) return next
  return { ...next, manualPauseInstance: next.currentInstanceKey }
}

export function noteManualResume(state) {
  if (!state || (state.manualPauseInstance == null && !state.pausedByAfk)) return state
  return { ...state, manualPauseInstance: null, pausedByAfk: false }
}

function pauseRunning(doc, now) {
  if (!doc || !Array.isArray(doc.strats)) return doc
  let changed = false
  const strats = doc.strats.map(s => {
    if (!s.time?.on && sc.running(s.timer)) {
      changed = true
      return { ...s, timer: sc.stop(s.timer, now), updatedAt: now }
    }
    return s
  })
  return changed ? { ...doc, strats } : doc
}

function pauseResult(nextState, doc, active, now) {
  const nextDoc = pauseRunning(doc, now)
  if (nextDoc !== doc) return { state: nextState, doc: nextDoc, action: 'pause' }
  if (!active) return { state: nextState, doc, action: 'none' }
  if (active.time?.on) return { state: nextState, doc, action: 'ignored-override' }
  return { state: nextState, doc, action: 'none' }
}

function startActive(doc, now, incrementMap) {
  const active = sc.activeStrat(doc)
  if (!active || active.time?.on) return doc
  const needStart = !sc.running(active.timer)
  if (!needStart && !incrementMap) return doc
  return {
    ...doc,
    strats: doc.strats.map(s => {
      if (s.id === active.id) {
        return {
          ...s,
          timer: needStart ? sc.start(s.timer, now) : s.timer,
          maps: incrementMap ? { ...s.maps, count: (s.maps?.count || 0) + 1 } : s.maps,
          updatedAt: now,
        }
      }
      // Preserve single-running-timer invariant (stratcalc.js).
      return needStart && sc.running(s.timer) ? { ...s, timer: sc.stop(s.timer, now), updatedAt: now } : s
    }),
  }
}

export function applyClientLogEvent(state, event, doc, now = Date.now()) {
  const st = state || createAutoTimerState()
  if (!event || typeof event !== 'object' || !doc) return { state: st, doc, action: 'none' }

  if (event.type === 'area-gen') {
    const seed = event.seed != null ? String(event.seed) : ''
    if (!seed) return { state: st, doc, action: 'none' }
    const pendingGen = { areaId: event.areaId || '', seed, level: event.level ?? null, receivedAt: now }
    return { state: { ...st, pendingGen }, doc, action: 'record-gen' }
  }

  const active = sc.activeStrat(doc)

  if (event.type === 'afk-on') {
    const res = pauseResult(st, doc, active, now)
    if (res.action === 'pause' && st.inCombat) {
      return { ...res, state: { ...res.state, pausedByAfk: true } }
    }
    return res
  }

  if (event.type === 'afk-off') {
    if (!st.pausedByAfk) return { state: st, doc, action: 'none' }
    const nextState = { ...st, pausedByAfk: false }
    if (!st.inCombat) return { state: nextState, doc, action: 'none' }
    if (!active) return { state: nextState, doc, action: 'none' }
    if (active.time?.on) return { state: nextState, doc, action: 'ignored-override' }
    if (st.currentInstanceKey && st.manualPauseInstance === st.currentInstanceKey) {
      return { state: nextState, doc, action: 'ignored-manual-pause' }
    }
    const nextDoc = startActive(doc, now, false)
    return { state: nextState, doc: nextDoc, action: nextDoc !== doc ? 'resume' : 'none' }
  }

  if (event.type === 'zone') {
    const zone = String(event.zone ?? '').trim()
    if (!zone) return { state: st, doc, action: 'none' }

    const freshGen = st.pendingGen && (now - st.pendingGen.receivedAt <= PENDING_GEN_TTL_MS)
      ? st.pendingGen
      : null

    // If the zone name itself is a hideout/town, classify as safe without discarding an
    // unentered combat area-gen (e.g. opened portals in hideout, visited town).
    if (isSafeZoneName(zone)) {
      const keepGen = freshGen && !isSafeAreaId(freshGen.areaId) ? freshGen : null
      return pauseResult({ ...st, pendingGen: keepGen, inCombat: false, pausedByAfk: false }, doc, active, now)
    }

    if (classifyZone(zone, freshGen?.areaId) === 'safe') {
      return pauseResult({ ...st, pendingGen: null, inCombat: false, pausedByAfk: false }, doc, active, now)
    }

    // Combat zone entry
    let instanceKey
    let isNewInstance = false
    let countedSeeds = st.countedSeeds
    let instanceSeq = st.instanceSeq

    if (freshGen && freshGen.seed) {
      instanceKey = `seed:${freshGen.seed}`
      if (!st.countedSeeds.includes(freshGen.seed)) {
        isNewInstance = true
        countedSeeds = [...st.countedSeeds.slice(-(MAX_TRACKED_SEEDS - 1)), freshGen.seed]
      }
    } else if (st.lastCombatZone != null && st.lastCombatZone === zone) {
      // Portal re-entry into the same map (no new area-gen preceded it)
      instanceKey = st.currentInstanceKey ?? `zone:${zone}#${instanceSeq}`
      isNewInstance = false
    } else {
      // Distinct combat zone entered without an area-gen line
      instanceSeq += 1
      instanceKey = `zone:${zone}#${instanceSeq}`
      isNewInstance = true
    }

    const manuallyPausedHere = st.manualPauseInstance != null && st.manualPauseInstance === instanceKey
    const nextState = {
      ...st,
      pendingGen: null,
      currentInstanceKey: instanceKey,
      lastCombatZone: zone,
      countedSeeds,
      instanceSeq,
      manualPauseInstance: manuallyPausedHere ? st.manualPauseInstance : null,
      inCombat: true,
      pausedByAfk: false,
    }

    if (manuallyPausedHere) {
      return { state: nextState, doc, action: 'suppressed-manual-pause' }
    }
    if (!active) return { state: nextState, doc, action: 'none' }
    if (active.time?.on) return { state: nextState, doc, action: 'ignored-override' }

    const wasRunning = sc.running(active.timer)
    const nextDoc = startActive(doc, now, isNewInstance)
    const action = !wasRunning && isNewInstance
      ? 'resume-and-count'
      : !wasRunning
        ? 'resume'
        : isNewInstance
          ? 'count'
          : 'none'
    return { state: nextState, doc: nextDoc, action }
  }

  return { state: st, doc, action: 'none' }
}
