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
