# FINAL_GOAL.md — claude-autopilot

## Vision

A zero-human-in-the-loop wrapper around Claude Code or Codex that drives **any** repo from
empty-or-partial to *done-done* — production-grade, aesthetically polished,
internet-shippable to millions of users — by invoking a coding agent in an infinite
loop until `FINAL_GOAL.md` of the target repo is fully satisfied.

## Acceptance Criteria

1. **CLI.** `autopilot <repo>` (or `autopilot .`) starts the loop against any repo.
2. **Autonomy.** No interactive prompts. Permissions bypassed. Uses every tool,
   MCP server, subagent, and web resource the selected runtime has configured.
3. **Looping.** Each iteration: judge state → have the selected agent make one concrete unit
   of progress → commit → push → re-judge.
4. **Completion detection.** A dedicated judge invocation (separate from the
   worker) returns structured JSON; the loop terminates only when the judge
   confirms every acceptance criterion in the target's `FINAL_GOAL.md` is met
   *and* the repo is shippable (tests pass, docs current, UI polished,
   no placeholder code).
5. **Worklog.** Every iteration appends to the target repo's `WORKLOG.md`.
6. **Wrapper for future repos.** Installable globally (`npm link` / `npm i -g`)
   so any future project can be driven with a single command.
7. **Resilient.** Survives transient errors (rate limits, tool failures, merge
   conflicts) by retrying with backoff instead of exiting.
8. **Observable.** Pretty, color-coded console output with iteration counter,
   elapsed time, token usage (if available), and per-step status.
9. **Configurable.** Flags for `--agent`, `--max-iterations`, `--judge-model`,
   `--worker-model`, `--no-push`, `--dry-run`, `--resume`.
10. **Published.** Repo initialized, documented, committed, and pushed to a
    remote (GitHub) with a clear README.

## Enrichments Added

- **Judge/worker split.** Two runtime invocations per iteration: one that
  *does* work, one that *judges* whether to stop. Separation prevents the
  worker from prematurely declaring victory.
- **Codex parity.** `--agent codex` and `codex-autopilot` run the same loop
  through `codex exec` with GPT-5.5/GPT-5.4 defaults.
- **Heartbeat WORKLOG entries** let a human catch up at any point by reading
  the repo alone.
- **Crash resilience** via `--resume`: iteration state persisted to
  `.autopilot/state.json` inside the target repo.
- **Pretty logging** with kleur so long runs are tolerable to watch.

## Non-Goals (v0.1)

- No web UI — CLI only.
- No multi-repo orchestration — one repo per autopilot process.
- No cost caps beyond `--max-iterations`.
