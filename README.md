# claude-autopilot

> Zero-human-in-the-loop wrapper around Claude Code. Point it at any repo with a
> `FINAL_GOAL.md`; it runs Claude Code in an infinite loop until the goal is
> genuinely shipped.

## What it does

Every iteration:

1. **Judge** — spawns a read-only Claude session that reads `FINAL_GOAL.md`,
   walks the repo, runs tests, and returns a structured JSON verdict:
   `{done, summary, outstanding}`.
2. **Worker** — if not done, spawns a full-permissions Claude session
   (`permissionMode: 'bypassPermissions'`) that picks one concrete chunk of
   outstanding work, implements it end-to-end, tests it, commits, and pushes.
3. **Repeat** until the judge returns `done: true`.

The worker is explicitly instructed to **never** ask clarifying questions — it
spawns subagents or hits the web instead. All configured MCP servers are
inherited automatically.

## Install

```bash
git clone <this repo> claude-autopilot
cd claude-autopilot
npm install
npm run build
npm link   # exposes `autopilot` on your PATH
```

Requires:

- Node.js ≥ 20
- `ANTHROPIC_API_KEY` or a Claude Code login session already on this machine
- `git` and (optionally) `gh` for remote pushes

## Usage

```bash
# drive the current directory
autopilot .

# drive a specific repo
autopilot ~/projects/my-saas

# stop after 50 iterations (default: unlimited)
autopilot . --max-iterations 50

# commit but don't push
autopilot . --no-push

# just run the judge once and exit
autopilot . --dry-run

# resume from a crash using .autopilot/state.json
autopilot . --resume

# pick specific models
autopilot . --worker-model claude-opus-4-7 --judge-model claude-sonnet-4-6
```

## Prerequisites in the target repo

At minimum, a `FINAL_GOAL.md` at the repo root describing the acceptance
criteria. If it's missing, the worker's first iteration will create one by
inferring intent from README / package.json / existing code.

Recommended:

- `ARCHITECTURE.md` — living design doc the worker updates.
- `WORKLOG.md` — append-only log; the worker adds an entry per iteration.
- A configured `origin` remote (otherwise use `--no-push`).

## Safety

`autopilot` runs Claude Code with `permissionMode: 'bypassPermissions'`. It
will edit files, run arbitrary shell commands, install packages, and push to
`origin` without asking. **This is the whole point of the tool.** Do not run
it against a repo you are not willing to see modified autonomously. Run inside
a sandbox, container, or throwaway worktree if unsure.

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

## Troubleshooting

- **Rate limited** — autopilot exponentially backs off (up to 5 min) and
  continues automatically.
- **Worker keeps "finishing" the same chunk** — check `WORKLOG.md`; if the
  judge also keeps flagging it, the acceptance criterion is probably
  under-specified. Tighten `FINAL_GOAL.md`.
- **Judge output not parseable** — autopilot assumes `done: false` and retries
  next iteration.

## License

MIT.
