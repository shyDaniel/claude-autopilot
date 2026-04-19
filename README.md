# claude-autopilot

> Zero-human-in-the-loop wrapper around Claude Code. Point it at any repo with
> a `FINAL_GOAL.md`; it runs Claude Code in an infinite loop until the goal is
> genuinely shipped — with live observability and stagnation detection so you
> can check in anytime.

## What it does

Every iteration:

1. **Judge** — a read-only Claude session that reads `FINAL_GOAL.md`, walks the
   repo, runs tests, and returns a structured JSON verdict `{done, summary,
   outstanding}`.
2. **Worker** — if not done, a full-permission Claude session
   (`permissionMode: 'bypassPermissions'`) picks one concrete chunk of
   outstanding work, implements it end-to-end, tests it, commits, and pushes.
3. **Stagnation detector** — if the outstanding list stays ≥ 90% the same
   and no commits land for N iterations, autopilot halts and writes a
   `STAGNATION_REPORT.md` so you can refine `FINAL_GOAL.md` or the prompts.
4. **Repeat** until the judge returns `done: true`.

The worker is explicitly instructed to **never** ask clarifying questions — it
spawns subagents or hits the web instead. All configured MCP servers are
inherited automatically.

## Install

```bash
git clone https://github.com/shyDaniel/claude-autopilot
cd claude-autopilot
npm install
npm run build
npm link   # exposes `autopilot` on your PATH
```

Requires:

- Node.js ≥ 20
- `ANTHROPIC_API_KEY` (or an already-authenticated Claude Code login)
- `git` and (optionally) `gh` for remote pushes

## Usage

```bash
# drive the current directory until judge says done
autopilot run .

# drive a specific repo
autopilot ~/projects/my-saas

# cap iterations, disable stagnation detector, skip pushing
autopilot run . --max-iterations 50 --no-stagnation --no-push

# just run the judge once and exit
autopilot run . --dry-run

# resume after a crash
autopilot run . --resume

# pick specific models
autopilot run . --worker-model claude-opus-4-7 --judge-model claude-sonnet-4-6
```

### Surveillance (run in another shell, anytime)

```bash
# one-shot snapshot of current phase + last verdict
autopilot status <repo>

# live tail of the event stream, prettified
autopilot watch <repo>

# iteration-by-iteration history table
autopilot log <repo>

# replay the full history of a long run
autopilot watch <repo> --since 1
```

The surveillance commands read from files under `<repo>/.autopilot/`, so they
work whether the main loop is still running, crashed, or finished.

## How "done" is decided

The judge is prompted with an uncompromising senior-staff-engineer rubric:

- Every acceptance criterion in `FINAL_GOAL.md` implemented and tested.
- No placeholder text, TODOs, or stub code in user-visible surfaces.
- Build, lint, and tests all pass end-to-end.
- Documentation reflects current state.
- If there's a UI, it's visually polished — not lorem ipsum.
- "Something you would be proud to link on HN."

When in doubt, the judge returns `done: false`. A separate judge invocation
each iteration prevents the worker from declaring premature victory.

## What stagnation means

If 3 consecutive iterations produce the same outstanding list *and* land zero
new commits, autopilot assumes something is wrong and halts. Common causes:

1. **`FINAL_GOAL.md` is under-specified** — the judge keeps flagging the same
   gap because "done" is ambiguous. Tighten the wording.
2. **The worker lacks a tool / MCP** needed to make progress. Inspect
   `.autopilot/events.jsonl` to confirm.
3. **The worker prompt is too soft** on a specific failure mode. Edit
   `src/prompts.ts` and re-run.
4. **A brittle external dependency** (test flake, rate limit) keeps undoing
   progress. Inspect `.autopilot/iterations/NNNNNN/worker-transcript.md`.

The written `.autopilot/STAGNATION_REPORT.md` lists these hypotheses against
the recent history so you have a starting point.

## Artifacts written per iteration

Inside `<target-repo>/.autopilot/iterations/NNNNNN/`:

| File                     | What                                                |
| ------------------------ | --------------------------------------------------- |
| `verdict.json`           | The judge's structured output for that iteration    |
| `worker-transcript.md`   | Full text + tool calls the worker produced          |
| `diff.patch`             | `git diff` of what changed this iteration           |
| `diff.stat`              | `--stat` summary of the diff                        |
| `commits.txt`            | SHAs + subjects of commits added this iteration     |
| `metrics.json`           | Duration, commit count, outstanding count, done flag|

## Exit codes

| Code     | Meaning                               |
| -------- | ------------------------------------- |
| `0`      | Judge returned `done: true`           |
| `1`      | Fatal error                           |
| `2`      | Reached `--max-iterations`            |
| `3`      | Stagnation detected                   |
| `130/143`| Interrupted (SIGINT/SIGTERM)          |

## Safety

`autopilot run` executes Claude Code with `permissionMode: 'bypassPermissions'`.
It edits files, runs arbitrary shell commands, installs packages, and pushes to
`origin` without asking. **This is the whole point of the tool.** Do not run it
against a repo you are not willing to see modified autonomously. Run inside a
sandbox, container, or throwaway worktree if unsure.

`autopilot status` / `watch` / `log` are read-only and safe to run any time.

## License

MIT.
