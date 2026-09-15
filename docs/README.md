# docs/

Architecture & maintenance docs for Arbiter (the PoE2 economy dashboard).

## Start here to build

- [`dev-notes.md`](./dev-notes.md) — the working loop & hard-won gotchas: the three environments
  (web/desktop-dev/packaged), how to deploy to the web test env, the "dev runs the compiled
  backend binary" trap, board cache keys, the settings-feature checklist, testing & CDP driving,
  and a where-things-live map. **Read before touching code.**

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
- [`db-split-handoff.md`](./db-split-handoff.md) — **implementer starts here.** Ordered build
  plan, current-state facts, acceptance criteria, test plan, risks, PR sequence.

Status: **IMPLEMENTED** (2026-09-14) — `user.sqlite` + `market.sqlite` are live; `db-split-handoff.md`
is kept as the historical build plan.
