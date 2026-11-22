import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_BUDGETS,
  compareProfiles,
  evaluateBudgets,
  extractMetrics,
  formatReport,
  parseArgs,
} from '../../ops/profile.mjs'

function sampleProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    timestamp: '2026-11-22T17:00:00.000Z',
    meta: { sha: 'abc1234', branch: 'main', dirty: false, version: '0.3.17-beta.3', platform: 'darwin', arch: 'arm64' },
    artifacts: {
      backendBinary: {
        sizeMB: 21.5,
        sidecarSelftestMedMs: 1800,
        pyinstaller: { available: true, contaminantTotalMB: 0.0 },
      },
      frontend: { entryJsKB: 460.0, entryJsGzKB: 150.0, lineChartJsKB: 404.0, totalRawKB: 1370.0 },
      release: { dmgMiB: 201.0 },
    },
    backend: {
      db: { league: 'Forbidden Rites', leagueDigestRows: 425000 },
      peakRssMB: 320.0,
      ops: {
        'Graph.build()': { firstMs: 140.0, medMs: 135.0, minMs: 130.0, runs: 5 },
        'routes._find_routes(default)': { firstMs: 460.0, medMs: 280.0, minMs: 270.0, runs: 3 },
      },
    },
    runtime: {
      warmBoot: { healthMs: 2100, boardPaintedMs: 4500, fcpMs: 450 },
      peakDomNodes: 3500,
      peakListeners: 1200,
      peakRendererRssMB: 180,
      idleBoard: {
        totalMB: 650,
        byRole: { 'backend-main': 250, 'electron-renderer': 140 },
        electronCpuPct: 1.8,
      },
      leakCheck: { cycles: 5, deltaHeapMB: 1.2, deltaNodes: 40, deltaListeners: 10 },
      consoleErrors: [],
      exceptions: [],
      httpEndpoints: [
        { path: '/api/board?window=24', status: 200, coldMs: 40, warmMedMs: 2.5, warmMaxMs: 3.0 },
      ],
    },
    ...overrides,
  }
}

describe('ops/profile.mjs CLI and comparison helpers', () => {
  it('parses stage filters and flags cleanly', () => {
    const opts = parseArgs(['--only', 'artifacts,backend', '--quick', '--save', '--check', '--json'])
    assert.deepEqual([...opts.stages], ['artifacts', 'backend'])
    assert.equal(opts.quick, true)
    assert.equal(opts.save, true)
    assert.equal(opts.check, true)
    assert.equal(opts.json, true)
  })

  it('rejects unknown stages and flags', () => {
    assert.throws(() => parseArgs(['--only', 'bogus']), /Unknown stage/)
    assert.throws(() => parseArgs(['--nope']), /Unknown argument/)
  })

  it('extracts metrics and flags >20% regressions in compareProfiles', () => {
    const base = sampleProfile()
    const cur = sampleProfile()
    cur.artifacts.backendBinary.sizeMB = 32.0 // +48.8% regression
    cur.backend.ops['Graph.build()'].medMs = 136.0 // +0.7% noise, not regressed
    cur.runtime.httpEndpoints[0].warmMedMs = 3.5 // +1ms (+40% pct, but < 5ms jitter threshold)

    const extracted = extractMetrics(base)
    assert.equal(extracted['artifact.backendBinaryMB'].value, 21.5)
    assert.equal(extracted['backend.routes._find_routes(default)'].value, 460.0)

    const diff = compareProfiles(base, cur)
    const binRow = diff.find((r) => r.key === 'artifact.backendBinaryMB')
    const graphRow = diff.find((r) => r.key === 'backend.Graph.build()')
    const httpRow = diff.find((r) => r.key === 'http.board.warmMs')

    assert.equal(binRow.regressed, true)
    assert.equal(graphRow.regressed, false)
    assert.equal(httpRow.regressed, false)
  })

  it('evaluates performance budgets cleanly for passing and failing runs', () => {
    const ok = sampleProfile()
    assert.deepEqual(evaluateBudgets(ok, DEFAULT_BUDGETS, []), [])

    const bad = sampleProfile()
    bad.artifacts.backendBinary.pyinstaller.contaminantTotalMB = 9.1
    bad.runtime.peakDomNodes = 43309
    bad.runtime.idleBoard.electronCpuPct = 46.8
    bad.runtime.consoleErrors = ['boom']
    bad.runtime.sidecarIdleCheck = { sidecarAlive: true }

    const failures = evaluateBudgets(bad, DEFAULT_BUDGETS, [])
    assert.equal(failures.length, 5)
    assert.ok(failures.some((f) => f.includes('venv contamination')))
    assert.ok(failures.some((f) => f.includes('peak DOM nodes')))
    assert.ok(failures.some((f) => f.includes('idle Electron CPU')))
    assert.ok(failures.some((f) => f.includes('console errors')))
    assert.ok(failures.some((f) => f.includes('sidecar still alive')))
  })

  it('formats a readable text report with comparisons and budget failures', () => {
    const base = sampleProfile()
    const cur = sampleProfile()
    cur.runtime.peakDomNodes = 43309
    const diff = compareProfiles(base, cur)
    const fails = evaluateBudgets(cur, DEFAULT_BUDGETS, diff)
    const txt = formatReport(cur, diff, fails)
    assert.match(txt, /Arbiter Profile/)
    assert.match(txt, /\[Artifacts\]/)
    assert.match(txt, /\[Backend Compute\]/)
    assert.match(txt, /\[Packaged Runtime\]/)
    assert.match(txt, /\[Comparison vs Baseline\]/)
    assert.match(txt, /\[Budget Failures\]/)
  })
})
