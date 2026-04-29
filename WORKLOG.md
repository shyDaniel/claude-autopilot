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

## 2026-04-19 — self-refinement + model fallback (v0.3.0)

Made autopilot genuinely autonomous end-to-end: it now improves its own
prompts / source on stagnation, and transparently downgrades to Sonnet when
Opus hits rate-limit / overload / quota errors.

**New modules:**

- [src/model.ts](src/model.ts) — `ModelSelector` with sticky downgrade from a
  configurable `{primary, fallback}` pair (default
  `claude-opus-4-7`→`claude-sonnet-4-6`). `withModel(selector, fn)` wraps any
  SDK call and retries once on quota-like errors. Quota classifier matches
  `rate_limit`, `overloaded`, `insufficient_quota`, `credit_balance`,
  `over_capacity`, `529`, `429`, `too many requests` (case-insensitive).
- [src/commands/refine.ts](src/commands/refine.ts) — `runMetaRefinement()`
  spawns a Claude Code session with `cwd = <autopilot source repo>`, passes
  it the stagnation report + paths to recent iteration artifacts, and lets it
  edit autopilot's own source. Runs `npm install && npm test && npm run
  build` afterward; refuses to relaunch on a broken autopilot. On success,
  `relaunchAutopilot()` re-execs `node <argv[1]> <args...> --resume` with
  inherited stdio. `detectAutopilotSource()` walks up from `import.meta.url`
  to find a writable git checkout named `claude-autopilot`.
- New prompt `metaRefinePrompt()` in [src/prompts.ts](src/prompts.ts)
  instructs the meta-agent to diagnose the stagnation, make a surgical fix
  to autopilot (typically prompts or metrics), and verify tests + build
  before committing.

**Changes:**

- Worker and judge now take a `ModelSelector` instead of a raw `model?` field;
  they both call `withModel()` internally. Fallback events are emitted with
  `kind: 'error'` so `autopilot watch` shows the downgrade live.
- Loop threads a `workerSelector` and `judgeSelector` through each iteration;
  on stagnation, a fresh selector is used for the meta-agent so a sticky
  worker downgrade doesn't automatically weaken the refinement attempt.
- `AutopilotState` gained `refinementsSoFar` counter; `loadState()` hydrates
  old state files that predate this field.
- CLI gained `--worker-model`, `--worker-fallback-model`, `--judge-model`,
  `--judge-fallback-model`, `--no-auto-refine`, `--autopilot-source <path>`,
  `--max-refinements <n>` (default 3).

**Tests added:** `test/model.test.ts` covers the quota classifier (7
positives, 4 negatives), `ModelSelector`'s sticky-downgrade semantics, and
`withModel`'s retry-once-then-rethrow behavior. 38 tests total, all passing.

## 2026-04-19 — email alerts on big events (v0.4.0)

Added targeted email notifications so big milestones reach you even if you're
not watching the terminal, while staying silent on per-iteration noise.

**New module:** [src/notifier.ts](src/notifier.ts)
- `loadNotifierConfig()` reads the same Gmail-SMTP env-var contract as
  news-alerter's `smtp_mailer.py` (SMTP_HOST / PORT / USER / PASSWORD /
  EMAIL_FROM / EMAIL_TO), so sharing `.env` across the two tools works.
- `Notifier` wraps `nodemailer` with STARTTLS on port 587. Methods: `send`
  (throttled, 10min min-interval per kind) and `sendImmediate` (for
  terminal events that fire at most once per process anyway).
- `evaluateBigProgress()` is the pure decision function: alerts on a
  single-iteration drop of ≥ 5 outstanding items (one-shot), OR when
  current ≤ baseline/2 AND baseline − current ≥ 3 (cumulative halving).
  Baseline resets after each alert to prevent retriggering on the same
  gain.

**Four alert kinds, nothing else:**

| Kind              | Trigger                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `done`            | Judge returns `done: true` — project shipped                             |
| `big-progress`    | `evaluateBigProgress()` returns `alert: true`                            |
| `self-refined`    | Meta-refinement agent committed a fix + autopilot relaunched             |
| `needs-attention` | Refinement failed / auto-refine disabled — human intervention required   |

**Wired** into [src/autopilot.ts](src/autopilot.ts) at each trigger point.
Enabled automatically when SMTP creds are in env; disabled with
`--no-email`.

**Tests:** `test/notifier.test.ts` covers `evaluateBigProgress` (8 cases:
one-shot threshold, halving floor, growth, reason priority) and
`loadNotifierConfig` env resolution (4 cases). 50 tests total, all
passing.

**Dependency:** added `nodemailer` + `@types/nodemailer`.

## 2026-04-29 — Codex runtime parity

Added Codex as a first-class autopilot runtime while keeping Claude Code as the
backwards-compatible default. `autopilot run . --agent codex` and the new
`codex-autopilot` bin now drive the same judge/worker/self-refinement loop via
`codex exec`, with GPT-5.5 -> GPT-5.4 sticky fallback and MCP config injected
through Codex `-c mcp_servers...` overrides.

Updated prompts and docs to describe a selected "agent runtime" rather than a
Claude-only flow. Added `test/codex.test.ts` to cover Codex MCP TOML override
rendering.
