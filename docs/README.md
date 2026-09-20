# docs/

Architecture & maintenance docs for Arbiter (the PoE2 economy dashboard).

Index last reconciled against the code on **2026-09-20** (desktop 0.3.1). Most docs here are
records of work that has shipped; each one's header states what is built and what is not. Where a
doc and the code disagree, the code wins — fix the doc.

## Start here to build

- [`dev-notes.md`](./dev-notes.md) — the working loop & hard-won gotchas: the three environments
  (web/desktop-dev/packaged), how to deploy to the web test env (`ops/deploy-web.sh`), the "dev
  runs the compiled backend binary" trap, board cache keys, the settings-feature checklist,
  testing & CDP driving, and a where-things-live map. **Read before touching code.**
- [`desktop-debugging.md`](./desktop-debugging.md) — drive the real renderer over CDP before
  claiming a UI change works.
- [`release-runbook.md`](./release-runbook.md) — cutting a desktop release step by step, both
  channels (stable `desktop-v<ver>` and `x.y.z-beta.N` pre-release). Shipping needs explicit
  per-change authorization — see CLAUDE.md.
- [`market-data-sources.md`](./market-data-sources.md) — **where prices come from**: the in-game
  Currency Exchange hourly digest is the sole source; the trade site's whisper-based Bulk Item
  Exchange is deprecated, and why. Read before touching anything that produces a price.
- [`ui-styleguide.md`](./ui-styleguide.md) — the visual contract: §0 Restraint, the design tokens,
  the component vocabulary, and what `npm run lint:style` enforces.

## Open bugs

- [`bugs/2026-09-18-ee2-history-drops-after-idle.md`](./bugs/2026-09-18-ee2-history-drops-after-idle.md) — **OPEN**: the EE2 query worker's planned 10-minute idle exit is counted as a crash, so the 5-minute restart throttle silently drops every price check after a 10–15 min pause. Diagnosed from beta telemetry; fix proposed, not built.
- [`bugs/2026-09-17-release-publish-not-atomic.md`](./bugs/2026-09-17-release-publish-not-atomic.md) — **CLOSED**: releases went live before their files did; fixed by the draft-first, no-tag, manifests-last, speed-cut, verify-then-flip flow in `desktop/scripts/release-assets.mjs` (proven on 0.2.61). Resolution at the top, investigation log below.

## UI — theme presets + polish (SHIPPED, 0.2.63 / 0.3.0)

- [`ui-joy-plan.md`](./ui-joy-plan.md) — the `/arena`-synthesized plan for the `:root[data-theme]`
  preset system (colour only, never layout) and the polish pass that came with it. **Built**: six
  presets (Vault, Arbiter of Ash, Arbiter of Divinity, Trial of the Sekhemas, Vaal, Azmeri) plus a
  custom theme builder that derives a full token table from eight primaries, the rgba-literal sweep,
  and the linter checks that keep presets honest. Its header lists what was deferred (tone curation,
  the `<select>`→`CurrencyPicker` swap, chart skeletons) and the one item the owner reverted (B1 —
  prices still count up on mount, deliberately). Read with `ui-styleguide.md`.

## Trading — the live half, then the EE2 wave (SHIPPED)

- [`trading-rework-research.md`](./trading-rework-research.md) — the **locked design decisions** for
  the Trading tab's live half: desktop-only, never auto-fire a teleport, a sound on every ping,
  human-in-the-loop throughout. These still govern `desktop/src/trade/`. The staged PR plan that
  consumed this brief was deleted once every PR shipped; this is the durable half.
- [`trading-workspace-roadmap.md`](./trading-workspace-roadmap.md) — the `/arena`-synthesized plan for
  the ExiledExchange2 History folder (vendored EE2 query port, zero-network `?q=` links, one ingest
  intent), clipboard-add and the QOL catalogue, further EE2 integrations, the zoom fix and UI polish,
  sequenced into test-gated batches with beta-telemetry verification. **Shipped 0.2.56 → 0.2.61**; the
  status block at its top lists the commits per batch and the deviations.

## Feedback reports ("Report a problem") — SHIPPED (0.3.0)

- [`feedback-implementation-plan.md`](./feedback-implementation-plan.md) — the design, the threat
  model, and what was built: the app seals one `.arb` file (X25519 → HKDF → AES-GCM to the owner's
  public key), the user drags it into a Discord forum post, and a sandboxed listener on shazam opens
  it. No drop point, no credential in the app, nothing that can bill. Day-to-day operation is in
  `dev-notes.md` → "Feedback reports".

## Strategy ecosystem — build plan & handoff

- [`strategy-ecosystem-plan.md`](./strategy-ecosystem-plan.md) — the roadmap for expanding the
  Strategy tab into a wealth-tool ecosystem. Phases 1, 1.5, 2 (Ghost Wealth), 3 (league-arc), 4
  (signal inbox), 5 (centrality), 6 (sidecar) and 7a are **all shipped**; **Phase 7b (deploy
  efficiency — PyInstaller `--onedir`, not re-shipping an unchanged snapshot) is the one part never
  started.** Includes cross-cutting decisions, per-phase specs, learnings from Convert, and the
  build/validate workflow.

## Database split (user vs market data) — IMPLEMENTED (2026-09-14)

- [`db-architecture.md`](./db-architecture.md) — the design: two SQLite files
  (`user.sqlite` persisted+migrated, `market.sqlite` disposable+snapshot-seeded+catch-up),
  data classification, seeding, and cross-DB access. **Read first.**
- [`db-maintenance.md`](./db-maintenance.md) — the going-forward rulebook: how to add user
  migrations, how to change market schema + refresh the snapshot, how to classify new kv keys.
- [`db-split-handoff.md`](./db-split-handoff.md) — the historical build plan (kept for the
  reasoning; the living rules are the two docs above).
