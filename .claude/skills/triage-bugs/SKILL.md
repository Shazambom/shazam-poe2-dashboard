---
name: triage-bugs
description: Pull every new (not yet looked at) bug report from the Discord feedback inbox and start one subagent per report to reproduce it in a small isolated failing test; also resolve or close reports, and resolve the ones fixed by merged commits. Use when the owner asks to triage, look at, reproduce, close or resolve bug reports.
---

# Triage bug reports

Reports arrive as Discord posts in #bug-reports. The feedback bot on shazam opens each one into
`feedback-inbox/<report>/`, which holds:
- `report.json`: the app's state;
- `logs/`: main, backend, renderer and updater logs;
- `screens/NN-<screen>.jpg`: a picture of every screen;
- `discord.json`: the post's title and the thread's messages, from reporter / other;
- `status.json`: new → triaged → resolved or closed.

A post without a readable report lands in `posts/<threadId>/` with the same `discord.json` and `status.json`.

`ops/bugs.sh` is the only interface. Read its header. It goes through `sshshazambom`, and the bot is
the inbox's only writer: an action asks the bot, and the bot applies it within a minute.

## Arguments

- none, or `new`: triage every new report.
- `<report>`: triage that one, e.g. `XWZGZ0` or `posts/1555…`.
- `resolve <report>` / `close <report>`: mark it resolved or closed. The bot replies in the thread
  with a fixed text and archives the thread where it can.
- `resolve-merged`: resolve every open report named by a merged commit's `Fixes-Report: <id>` trailer.

## Triage: one agent per report

1. `ops/bugs.sh list new`. If it's empty, say so and stop.
2. For each report:
   1. Pull it into this session's scratchpad: `ops/bugs.sh pull <report> <scratchpad>/bugs`.
   2. Mark it looked at: `ops/bugs.sh triage <report>`. It then drops out of `list new`, so a second
      run never starts a duplicate agent.
3. Start **one background Agent per report, all in a single message**:
   - `subagent_type: general-purpose`;
   - `model: opus`;
   - `isolation: worktree`, so each repro test lives on its own branch and never in the main tree;
   - `description`: `Reproduce bug <report>`;
   - the prompt below, with `<report>`, `<dir>` and the listing row filled in.
4. When they report back, give the owner one short line per report:
   - reproduced (test path and branch) / not reproduced (what was missing) / not a bug;
   - the likely cause, with `file:line`.

   Don't fix anything, merge, deploy or resolve as part of triage.

### The agent prompt

```
Reproduce Arbiter bug report <report> in a small, isolated, FAILING test. Do not fix it.

The report: <dir> (read all of it). Start with discord.json (the reporter's words: the bug), then
report.json (manifest: version, platform, channel; state: diag, status, settings, backfill), the
logs, and the screens (screens/00-current.jpg is what the reporter was looking at). Listing row:
<row JSON>.

Repo: your worktree of /Users/ianmoreno/shazam-poe2-dashboard. Read CLAUDE.md and docs/dev-notes.md
first. Find the code the report points at, then write the smallest test that fails the way the
reporter describes, in the right suite:
- backend pytest: backend/tests, run with DATA_DIR="$(mktemp -d)" MARKET_SEED= .venv-test/bin/python -m pytest <file>
- frontend: frontend/test/*.test.mjs, run with node --test
- desktop: desktop/test
Run it and keep its red output. A test that passes means the bug isn't reproduced: say so, and
say what the report would have needed.

Rules:
- Never call any pathofexile.com endpoint.
- Never run the packaged app against the owner's data, never PUT or POST to a running backend,
  never touch ~/Library/Application Support/Arbiter.
- Never post anywhere, never deploy, never commit outside your worktree.
- Item and price oddities aren't bugs without evidence.
- Every command on shazam goes through sshshazambom, though you shouldn't need one.

Reply in <= 250 words:
- VERDICT: reproduced | not reproduced | not a bug
- TEST: path, the command, and the failing assertion line
- CAUSE: file:line and one sentence
- FIX: one sentence, the smallest change
- MISSING: what the report lacked, if anything
```

## Fixing and closing

- **Fixing:** a fix goes through /tdd, starting from the agent's red test. The commit carries a trailer
  `Fixes-Report: <report>`, one line per report it fixes.
- **Resolving:** once the fix is merged to main, run `ops/bugs.sh resolve-merged`. Each named report
  gets the bot's fixed "the fix ships in the next Arbiter update" reply.
- **Closing:** run `ops/bugs.sh close <report>` for a report that won't be fixed (a duplicate, not a
  bug, or the reporter's own setup). Only on the owner's say-so: it replies in their Discord.
- **Running it on a schedule:** `/loop 1h /triage-bugs`.

## Notes

- `resolve` and `close` post in a public thread, so run them only when the owner asked, or via
  `resolve-merged` after a merge the owner made.
- The reporter's Discord screenshots aren't kept. The bot keeps text only, never the reporter's
  bytes. The report's own screens are the app's.
