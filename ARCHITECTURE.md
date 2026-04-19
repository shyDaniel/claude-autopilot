# ARCHITECTURE.md — claude-autopilot

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│  autopilot <repo>                                            │
│                                                              │
│  ┌────────────┐   judge       ┌─────────────────┐            │
│  │ CLI (commander) ├──────────►│  Judge Claude   │            │
│  └──────┬─────┘                │ (JSON verdict)  │            │
│         │                      └─────────┬───────┘            │
│         │ done?─────no──┐                │                    │
│         │               ▼                │                    │
│         │      ┌────────────────┐        │                    │
│         │      │ Worker Claude  │        │                    │
│         │      │ (bypassPerms,  │        │                    │
│         │      │  all tools)    │        │                    │
│         │      └────────┬───────┘        │                    │
│         │               │ commit+push    │                    │
│         │               ▼                │                    │
│         │      ┌────────────────┐        │                    │
│         │      │ Target repo    │◄───────┘                    │
│         │      │ git working    │                             │
│         │      │ directory      │                             │
│         │      └────────────────┘                             │
└──────────────────────────────────────────────────────────────┘
```

## Key modules

- [src/index.ts](src/index.ts) — CLI entry (commander).
- [src/autopilot.ts](src/autopilot.ts) — the infinite loop.
- [src/worker.ts](src/worker.ts) — spawns a worker Claude Code session using
  `@anthropic-ai/claude-agent-sdk`'s `query()` with `permissionMode:
  'bypassPermissions'` and all MCPs inherited.
- [src/judge.ts](src/judge.ts) — spawns a judge session that must return JSON
  verdict `{done, summary, outstanding}`.
- [src/prompts.ts](src/prompts.ts) — system/user prompts for worker & judge.
- [src/state.ts](src/state.ts) — persists iteration counter / last verdict to
  `.autopilot/state.json` inside the target repo for `--resume`.
- [src/logging.ts](src/logging.ts) — pretty console output with kleur.

## Control flow

```
while (!stopRequested) {
  iteration++
  verdict = await judge(repo)
  if (verdict.done) break
  await worker(repo, verdict.outstanding)
  state.save({iteration, lastVerdict: verdict})
}
```

A per-iteration timeout and exponential backoff on SDK errors keep the process
alive indefinitely, matching the "infinite tokens to burn" brief.

## Why two Claude invocations?

A single agent that both *works* and *decides when to stop* tends to declare
victory prematurely. A separate judge, with a strict "uncompromising reviewer"
prompt and JSON-only output, keeps the worker honest.

## Permissions

Worker runs with `permissionMode: 'bypassPermissions'`. This is the whole
point — the tool exists to remove the human from the loop. Users who don't want
this should not run autopilot. The README makes this explicit.

## Extension points

- **MCPs.** Whatever is configured in the user's `~/.claude/settings.json` or
  project-level `.mcp.json` is inherited automatically by the spawned SDK
  sessions.
- **Models.** `--worker-model` and `--judge-model` override defaults.
- **Hooks.** Future work: inject an `onStop` hook that re-enters the loop if
  the worker exits while goals remain, as a second line of defense.
