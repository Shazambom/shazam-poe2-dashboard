import React, { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

// The header logo. Idle → the Annulment orb (our mark). While the local backend is
// cold-building price history it SPINS, and every full rotation lands on a different
// base orb — a little slot-machine of currency that says "working" without an ugly bar.
const CDN = 'https://web.poecdn.com'
// The eight base orbs, hotlinked from GGG's CDN (same pattern as every currency icon —
// nothing bundled). Order: augment, transmute, regal, exalt, chaos, annul, fracture, divine.
const ORBS = [
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lBZGRNb2RUb01hZ2ljIiwic2NhbGUiOjEsInJlYWxtIjoicG9lMiJ9XQ/c8ad0ddc84/CurrencyAddModToMagic.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lVcGdyYWRlVG9NYWdpYyIsInNjYWxlIjoxLCJyZWFsbSI6InBvZTIifV0/2f8e1ff9f8/CurrencyUpgradeToMagic.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lVcGdyYWRlTWFnaWNUb1JhcmUiLCJzY2FsZSI6MSwicmVhbG0iOiJwb2UyIn1d/e8fb148e80/CurrencyUpgradeMagicToRare.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lBZGRNb2RUb1JhcmUiLCJzY2FsZSI6MSwicmVhbG0iOiJwb2UyIn1d/ad7c366789/CurrencyAddModToRare.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lSZXJvbGxSYXJlIiwic2NhbGUiOjEsInJlYWxtIjoicG9lMiJ9XQ/c0ca392a78/CurrencyRerollRare.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQW5udWxsT3JiIiwic2NhbGUiOjEsInJlYWxtIjoicG9lMiJ9XQ/2daba8ccca/AnnullOrb.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvRnJhY3R1cmluZ09yYiIsInNjYWxlIjoxLCJyZWFsbSI6InBvZTIifV0/8b85ed1dc2/FracturingOrb.png',
  '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lNb2RWYWx1ZXMiLCJzY2FsZSI6MSwicmVhbG0iOiJwb2UyIn1d/2986e220b3/CurrencyModValues.png',
].map(p => CDN + p)
const ANNUL = 5   // index of the Annulment orb — the resting mark

const rand = (n) => Math.floor(Math.random() * n)

export default function BrandOrb({ onDone }) {
  const [running, setRunning] = useState(false)
  const [label, setLabel] = useState('')
  const [idx, setIdx] = useState(() => rand(ORBS.length))
  const wasRunning = useRef(false)

  useEffect(() => {
    let timer
    const tick = async () => {
      let d = null
      try { d = await api.backfill() } catch {}
      const on = !!(d && d.running && (d.phase === 'crawling' || d.phase === 'leagues'))
      setRunning(on)
      if (on) {
        setLabel(d.phase === 'leagues'
          ? 'Building your dashboard — fetching leagues…'
          : `Building your dashboard — ${d.league || 'market history'} · ${d.league_done}/${d.league_total} · ${Math.round(d.pct || 0)}%`)
      }
      if (wasRunning.current && !on) { try { onDone && onDone() } catch {} }   // finished → refresh views
      wasRunning.current = on
      timer = setTimeout(tick, on ? 1500 : 8000)   // poll fast while building
    }
    tick()
    return () => clearTimeout(timer)
  }, []) // eslint-disable-line

  // Each completed rotation swaps to a different random orb (never repeat back-to-back).
  const onIter = () => setIdx(i => { let n = rand(ORBS.length); if (n === i) n = (n + 1) % ORBS.length; return n })

  return (
    <img
      className={`brand-logo${running ? ' orb-spin' : ''}`}
      src={ORBS[running ? idx : ANNUL]}
      alt="" width="24" height="24"
      title={running ? label : 'Arbiter'}
      onAnimationIteration={onIter}
      onError={e => { e.currentTarget.style.visibility = 'hidden' }}
    />
  )
}
