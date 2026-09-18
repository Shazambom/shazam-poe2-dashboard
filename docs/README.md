# docs/

Architecture & maintenance docs for Arbiter (the PoE2 economy dashboard).

## Start here to build

- [`bugs/2026-09-18-ee2-history-drops-after-idle.md`](./bugs/2026-09-18-ee2-history-drops-after-idle.md) — **OPEN**: the EE2 query worker's planned 10-minute idle exit is counted as a crash, so the 5-minute restart throttle silently drops every price check after a 10–15 min pause. Diagnosed from beta telemetry; fix proposed, not built.
- [`bugs/2026-09-17-release-publish-not-atomic.md`](./bugs/2026-09-17-release-publish-not-atomic.md) — **CLOSED**: releases went live before their files did; fixed by the draft-first, no-tag, manifests-last, speed-cut, verify-then-flip flow in `desktop/scripts/release-assets.mjs` (proven on 0.2.61). Resolution at the top, investigation log below.
- [`market-data-sources.md`](./market-data-sources.md) — **where prices come from**: the in-game Currency Exchange hourly digest is the sole source; the trade site's whisper-based Bulk Item Exchange is deprecated, and why.
- [`dev-notes.md`](./dev-notes.md) — the working loop & hard-won gotchas: the three environments
  (web/desktop-dev/packaged), how to deploy to the web test env (`ops/deploy-web.sh`), the "dev
  runs the compiled backend binary" trap, board cache keys, the settings-feature checklist,
  testing & CDP driving, and a where-things-live map. **Read before touching code.**
- [`desktop-debugging.md`](./desktop-debugging.md) — drive the real renderer over CDP before
  claiming a UI change works.

## UI — theme presets + polish (PLAN, 2026-09-18; nothing built)

- [`ui-joy-plan.md`](./ui-joy-plan.md) — `/arena`-synthesized plan: a `:root[data-theme]` preset system (Vault / Arbiter of Ash / Arbiter of Divinity / Trial of the Sekhemas / Vaal) over the existing token contract, the rgba-literal sweep + linter extension it depends on, and a prioritized polish list (§0 cuts first, then motion honesty, then themes). Read with `ui-styleguide.md`.

## Trading workspace — roadmap (implemented and shipped, 0.2.56 → 0.2.61)

- [`trading-workspace-roadmap.md`](./trading-workspace-roadmap.md) — the `/arena`-synthesized plan for the
  ExiledExchange2 History folder (vendored EE2 query port, zero-network `?q=` links, one ingest intent),
  clipboard-add and the QOL catalogue, further EE2 integrations, the zoom fix and UI polish, sequenced into
  test-gated batches with beta-telemetry verification. Successor to `trading-rework-plan.md`. The status
  block at its top lists the commits per batch and the deviations.

## Strategy ecosystem — build plan & handoff

- [`strategy-ecosystem-plan.md`](./strategy-ecosystem-plan.md) — the roadmap for expanding the
  Strategy tab into a wealth-tool ecosystem (Convert ✅, gold-value slider 🔧, Ghost Wealth,
  Timing/league-arc, What's-about-to-move, centrality, sidecar). **An agent continuing this work
  starts here.** Includes cross-cutting decisions, per-phase specs, learnings from Convert, and
  the build/validate workflow.

## Database split (user vs market data) — IMPLEMENTED (2026-09-14)

- [`db-architecture.md`](./db-architecture.md) — the design: two SQLite files
  (`user.sqlite` persisted+migrated, `market.sqlite` disposable+snapshot-seeded+catch-up),
  data classification, seeding, and cross-DB access. **Read first.**
- [`db-maintenance.md`](./db-maintenance.md) — the going-forward rulebook: how to add user
  migrations, how to change market schema + refresh the snapshot, how to classify new kv keys.
- [`db-split-handoff.md`](./db-split-handoff.md) — the historical build plan (kept for the
  reasoning; the living rules are the two docs above).

Status: **IMPLEMENTED** (2026-09-14) — `user.sqlite` + `market.sqlite` are live; `db-split-handoff.md`
is kept as the historical build plan.
