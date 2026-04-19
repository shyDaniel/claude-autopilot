# ARCHITECTURE.md — claude-autopilot

## Overview

`autopilot` is a long-running CLI that drives any target repo toward its
`FINAL_GOAL.md`. It also exposes **surveillance subcommands** (`status`,
`watch`, `log`) so a human can check what it's doing at any time from a
separate shell.

```
┌────────────────────────────────────────────────────────────────────────┐
│  autopilot run <repo>                                                  │
│                                                                        │
│   ┌──────────────┐   judge       ┌───────────────────┐                 │
│   │ CLI (commander)├───────────► │  Judge Claude     │                 │
│   └──────┬───────┘               │  (JSON verdict)   │                 │
│          │                       └─────────┬─────────┘                 │
│          │ done?──no──┐                    │                           │
│          │            ▼                    │                           │
│          │   ┌──────────────────┐          │                           │
│          │   │  Worker Claude   │          │                           │
│          │   │  bypassPerms,    │          │                           │
│          │   │  all tools/MCPs  │          │                           │
│          │   └─────────┬────────┘          │                           │
│          │             │ commit+push       │                           │
│          ▼             ▼                   │                           │
│   ┌──────────────────────────┐             │                           │
│   │  Stagnation detector     │◄────────────┘                           │
│   │  (halts if K consecutive │                                         │
│   │   iterations show no     │                                         │
│   │   progress)              │                                         │
│   └──────────────────────────┘                                         │
│                                                                        │
│   Every step appends to:                                               │
│     .autopilot/events.jsonl    ← append-only event stream              │
│     .autopilot/status.json     ← live "what am I doing right now"      │
│     .autopilot/state.json      ← durable resume data                   │
│     .autopilot/iterations/NNN/ ← per-iteration artifacts               │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│  Surveillance (can run in a separate shell, any time)                  │
│                                                                        │
│   autopilot status <repo>  → snapshot from status.json                 │
│   autopilot watch <repo>   → tail -f on events.jsonl (prettified)      │
│   autopilot log <repo>     → iteration-by-iteration summary            │
└────────────────────────────────────────────────────────────────────────┘
```

## Module map

| Module                                    | Responsibility                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| [src/index.ts](src/index.ts)              | CLI dispatch — `run` / `status` / `watch` / `log` subcommands.             |
| [src/autopilot.ts](src/autopilot.ts)      | The infinite judge→worker loop; orchestrates state, events, artifacts.     |
| [src/judge.ts](src/judge.ts)              | Spawns a read-only Claude session, parses the fenced JSON verdict.         |
| [src/worker.ts](src/worker.ts)            | Spawns a full-permission Claude session; streams events; returns transcript.|
| [src/prompts.ts](src/prompts.ts)          | Worker & judge prompt templates.                                           |
| [src/events.ts](src/events.ts)            | Append-only JSONL event log.                                               |
| [src/status.ts](src/status.ts)            | Live snapshot of current phase / action.                                   |
| [src/state.ts](src/state.ts)              | Durable resume data (`.autopilot/state.json`).                             |
| [src/metrics.ts](src/metrics.ts)          | Repo snapshots, commit diffs, normalize bullets, stagnation detector.      |
| [src/artifacts.ts](src/artifacts.ts)      | Per-iteration disk artifacts + stagnation report writer.                   |
| [src/logging.ts](src/logging.ts)          | kleur-based console output.                                                |
| [src/commands/status.ts](src/commands/status.ts) | `autopilot status` implementation.                                  |
| [src/commands/watch.ts](src/commands/watch.ts)   | `autopilot watch` — polling tail with pretty formatting.            |
| [src/commands/log.ts](src/commands/log.ts)       | `autopilot log` — iteration-level history table.                    |
| [src/commands/refine.ts](src/commands/refine.ts) | Meta-refinement: spawn Claude on autopilot source, verify, relaunch.|
| [src/model.ts](src/model.ts)                     | `ModelSelector` + `withModel`: sticky Opus→Sonnet fallback.         |

## Model selection & sticky fallback

Worker and judge each get their own [`ModelSelector`](src/model.ts) with a
`{primary, fallback}` pair. Default: `{primary: claude-opus-4-7, fallback:
claude-sonnet-4-6}` for both. The SDK's `query()` is wrapped in
[`withModel`](src/model.ts):

```
try {
  return await fn(selector.current())        // primary
} catch (err) {
  if (quota-like err && !already downgraded) {
    selector.downgrade()                      // sticky for rest of run
    return await fn(selector.current())       // fallback
  }
  throw err
}
```

Quota classification matches `rate_limit`, `overloaded`, `insufficient_quota`,
`credit_balance`, `over_capacity`, `529`, `429`, `too many requests` (case-
insensitive). One successful downgrade sticks for the rest of the process —
no flapping, no re-probes — on the assumption that these conditions take
minutes-to-hours to clear and making progress matters more than staying on
Opus.

The meta-refinement agent uses a **fresh** selector so a sticky worker
downgrade doesn't automatically force the meta-agent onto a weaker model.

## Self-refinement on stagnation

When the stagnation detector fires, autopilot writes `STAGNATION_REPORT.md`
and — if `--auto-refine` (default on) — spawns a third kind of Claude
session: the **meta-refinement agent** at
[src/commands/refine.ts](src/commands/refine.ts).

```
stagnation detected
  ↓
writeStagnationReport()            → .autopilot/STAGNATION_REPORT.md
  ↓
detectAutopilotSource()            → walks import.meta.url upward to find
                                     a writable git checkout where
                                     package.json name == "claude-autopilot"
  ↓
runMetaRefinement()                → query() with cwd = autopilot source,
                                     prompt points at stagnation report +
                                     recent iteration artifacts in target
  ↓
verify: npm install && npm test && npm run build
  ↓
if HEAD advanced AND verification passed:
  state.refinementsSoFar += 1
  relaunchAutopilot()              → spawn(argv[0], [argv[1], ...opts, --resume])
                                     inherits stdio; await child exit
else:
  exit 3 and append failure note to STAGNATION_REPORT.md
```

Bounded by `--max-refinements` (default 3) so a pathological meta-agent can't
spin forever. Each refinement's transcript is saved under
`<target>/.autopilot/refinements/NNN/transcript.md` for audit.

## Why separate judge and worker?

A single agent that both *works* and *decides when to stop* tends to declare
victory prematurely. The judge runs with write tools **disallowed** and is
prompted to be uncompromising; its JSON output is mechanically parsed.

## Stagnation detection

Every iteration appends a snapshot to an in-memory `history[]`:

```ts
{ iter, outstanding[], headSha, commitCountTotal }
```

For each adjacent pair, we compute:

- **Jaccard similarity** of normalized outstanding bullets.
- **Commit delta** between HEAD shas.

Stagnation fires when, for `--stagnation-threshold` consecutive transitions
(default 3), Jaccard ≥ 0.9 AND commit delta = 0. On stagnation, autopilot:

1. Writes `.autopilot/STAGNATION_REPORT.md` summarizing recent iterations and
   possible root causes (FINAL_GOAL too vague, missing tool, brittle test, etc).
2. Emits a `stagnation` event.
3. Exits with code 3.

The human can then refine `FINAL_GOAL.md`, edit the autopilot prompts, or
run `autopilot run /path/to/claude-autopilot` to let autopilot drive its own
refinement.

## Observability surface (all inside target-repo `.autopilot/`)

| Path                         | Shape       | Who writes it             | Who reads it             |
| ---------------------------- | ----------- | ------------------------- | ------------------------ |
| `state.json`                 | JSON        | loop                      | loop (on `--resume`)     |
| `status.json`                | JSON        | loop + worker + judge     | `status` / external tools |
| `events.jsonl`               | JSON Lines  | loop + worker + judge     | `watch` / `log`          |
| `iterations/NNNNNN/`         | directory   | loop (end of iteration)   | human / judge            |
| `STAGNATION_REPORT.md`       | markdown    | loop (on stagnation)      | human                    |

Per-iteration artifacts include `verdict.json`, `worker-transcript.md`,
`diff.patch`, `diff.stat`, `commits.txt`, `metrics.json`.

## Exit codes

- `0` — judge returned `done: true`, goal satisfied.
- `1` — fatal error.
- `2` — reached `--max-iterations`.
- `3` — stagnation detected.
- `130/143` — interrupted (SIGINT/SIGTERM).

## Permissions

Worker runs with `permissionMode: 'bypassPermissions'`. This is the whole
point — the tool exists to remove the human from the loop. The README makes
this explicit.
