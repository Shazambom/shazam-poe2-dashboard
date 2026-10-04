# Building a feature — the flow (owner, 2026-10-03)

**Plan → TDD → QA → code review → send to the owner to review locally.** One step at a time: each
finishes, and its findings are fixed, before the next begins. The skills hold the method; this page holds
the order and what each step must produce.

1. **Plan.** It varies from session to session, so decide together what this feature needs. Options
   include:
   - parallel subagents exploring the parts of the app it touches;
   - online research;
   - an arena (the `/arena` skill) to compare competing designs;
   - an interactive mockup (an Artifact on the app's real tokens and data) for the owner to critique.

   None of these is required. Whatever the plan, reuse data the app already has (KISS) and classify game
   things only from game data. The plan ends when the owner says to implement it.
2. **TDD.** Use the `/tdd` skill.
   - Write each test first and watch it fail for the right reason.
   - Mutation-check the key tests.
   - `ops/run-tests.sh` must be green.
   - Drive the real app over CDP (`desktop-debugging.md`): snapshot the owner's data before, diff it
     after.
3. **QA.** Use the `/qa-eng` skill: one tester who knows only the behaviour spec drives the running app.
   Reproduce each defect yourself, fix the confirmed ones test-first, and re-verify in the app.
4. **Code review.** Use the `/code-review high` skill. Fix what it confirms, test-first, and keep the gate
   green.
5. **Send to the owner to review locally.**
   - Build the packaged app: `cd desktop && npm run dist:mac`, then
     `open desktop/release/mac-arm64/Arbiter.app`.
   - Report plainly: what was built, what QA and the review found and fixed, what wasn't covered, and any
     user data the run touched.
   - Shipping waits for an explicit "ship" (CLAUDE.md → "Web vs desktop"). Never commit unasked.

A request that arrives mid-flow waits until step 5 is handed over.
