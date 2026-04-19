# WORKLOG

## 2026-04-19 — initial scaffold (v0.1.0)

- Created project skeleton: `package.json`, `tsconfig.json`, `.gitignore`.
- Wrote `FINAL_GOAL.md`, `ARCHITECTURE.md` (diagram, module map, control flow).
- Implemented core modules:
  - [src/logging.ts](src/logging.ts) — kleur-based pretty logger.
  - [src/state.ts](src/state.ts) — `.autopilot/state.json` persistence for `--resume`.
  - [src/prompts.ts](src/prompts.ts) — worker + judge prompts.
  - [src/worker.ts](src/worker.ts) — `query()` wrapper with
    `permissionMode: 'bypassPermissions'` and all tools/MCPs inherited.
  - [src/judge.ts](src/judge.ts) — read-only judge session, parses fenced JSON
    verdict `{done, summary, outstanding}`.
  - [src/autopilot.ts](src/autopilot.ts) — infinite loop with exponential
    backoff on errors.
  - [src/index.ts](src/index.ts) — commander CLI with
    `--max-iterations / --no-push / --dry-run / --resume` flags.
- Added `bin/autopilot.js` shim so `npm link` / `npm i -g` works.
- Pushed to https://github.com/shyDaniel/claude-autopilot.

## 2026-04-19 — observability + stagnation detection (v0.2.0)

Rebuilt around a first-class **observability surface** so the human can watch
autopilot work on any repo from a separate terminal, and so autopilot can
detect when it's stuck and halt for refinement.

**New modules:**

- [src/events.ts](src/events.ts) — append-only JSONL event log at
  `.autopilot/events.jsonl`. Every phase boundary, tool call, text block,
  verdict, error, commit, and stagnation detection is a line.
- [src/status.ts](src/status.ts) — live `.autopilot/status.json` snapshot of
  current phase / iteration / action / stagnation counter / pid. Updated on
  every tool event.
- [src/metrics.ts](src/metrics.ts) — repo snapshots, commit deltas, bullet
  normalization, Jaccard similarity, and the stagnation detector.
- [src/artifacts.ts](src/artifacts.ts) — writes per-iteration artifacts:
  `verdict.json`, `worker-transcript.md`, `diff.patch`, `diff.stat`,
  `commits.txt`, `metrics.json`.
- [src/commands/status.ts](src/commands/status.ts) — `autopilot status` prints
  a pretty one-shot snapshot (including whether the autopilot process is still
  alive).
- [src/commands/watch.ts](src/commands/watch.ts) — `autopilot watch` polls
  `events.jsonl` and pretty-prints new lines, like `tail -f` but colorized and
  phase-aware. Supports `--since <iter>` to replay history first.
- [src/commands/log.ts](src/commands/log.ts) — `autopilot log` prints a
  one-line-per-iteration summary table (tool count, commits, verdict).

**Stagnation detector** (in [src/metrics.ts](src/metrics.ts)): if the
normalized outstanding set is ≥ 90% identical AND zero new commits land for
`--stagnation-threshold` consecutive iterations (default 3), autopilot writes
`.autopilot/STAGNATION_REPORT.md` and exits with code 3.

**Worker and judge rewired** to stream events + return transcripts, so every
action is visible in `events.jsonl` and `iterations/NNNNNN/worker-transcript.md`.

**CLI refactored** into subcommands: `run` (default), `status`, `watch`, `log`.

**Tests added** (vitest): cover bullet normalization, Jaccard, stagnation
detection (including resilience to reordering/case), verdict extraction edge
cases, and event log round-tripping.

**Exit codes standardized**: 0 done, 1 error, 2 max-iterations, 3 stagnation.
