# docs/

Architecture & maintenance docs for Arbiter (the PoE2 economy dashboard).

## Database split (user vs market data) — designed, not yet built

- [`db-architecture.md`](./db-architecture.md) — the design: two SQLite files
  (`user.sqlite` persisted+migrated, `market.sqlite` disposable+snapshot-seeded+catch-up),
  data classification, seeding, and cross-DB access. **Read first.**
- [`db-maintenance.md`](./db-maintenance.md) — the going-forward rulebook: how to add user
  migrations, how to change market schema + refresh the snapshot, how to classify new kv keys.
- [`db-split-handoff.md`](./db-split-handoff.md) — **implementer starts here.** Ordered build
  plan, current-state facts, acceptance criteria, test plan, risks, PR sequence.

Status: the split is fully designed but the code still uses a single `poe2arb.sqlite`.
