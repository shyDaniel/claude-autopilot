# agent-autopilot

[![CI](https://github.com/shyDaniel/agent-autopilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shyDaniel/agent-autopilot/actions/workflows/ci.yml)

> Zero-human-in-the-loop wrapper around Claude Code **or Codex**. Point it at
> any repo with a `FINAL_GOAL.md`; it runs a **skills-based** judge / eval /
> orchestrator / worker / evolve loop until the project is genuinely shipped —
> with live observability, sticky model fallback, and dynamic self-evolution
> when autopilot itself is the bottleneck.

## Skills

Each phase of the loop is a file-backed `SKILL.md` under `skills/`:

| Skill        | What it does                                                        |
| ------------ | ------------------------------------------------------------------- |
| `judge`      | Uncompromising shipping reviewer; returns `{done, outstanding}`.    |
| `eval`       | Adversarial second-pass critic; **overrides** the judge's "done" if anything still feels off (a real-world judge can be overruled on appeal indefinitely; so can this one). |
| `work`       | Implements one concrete chunk of outstanding work end-to-end.       |
| `orchestrate`| Decides what runs next: `work` / `reframe` / `evolve` / `exit-stuck` based on the *actual* loop state — not Jaccard / commit counts. |
| `reframe`    | Decomposes or rewrites a stuck subtask the worker keeps failing on. |
| `evolve`     | Edits autopilot's own SKILL.md / source to fix a systemic gap.      |

Editing a skill's SKILL.md is a no-code-change way to teach autopilot how to
behave. The `evolve` skill itself reads other skills and edits them when
the orchestrator decides autopilot is the bottleneck.

## What it does

Every iteration:

1. **Judge** — a read-mostly Claude or Codex session reads `FINAL_GOAL.md`,
   walks the repo, runs tests, and returns `{done, summary, outstanding}`.
2. **Eval (if judge says done)** — a separate adversarial critic session
   drives the product like a real user, takes screenshots, and may overrule
   the judge with a list of polish blockers. Eval can override `done`
   indefinitely; only when **judge AND eval** both pass does autopilot ship.
3. **Orchestrator** — given the latest verdict, the recent history, the plan
   ledger, recent commits, and the last two worker transcripts, an
   orchestrator session decides what to do next:
   - `work` → run the worker (default)
   - `reframe` → skip the worker; next iteration's judge will reframe a
     specific stuck subtask
   - `evolve` → spawn the meta-refinement agent in agent-autopilot's source
     repo; it edits a `SKILL.md` or `src/` file, runs `npm test && npm run
     build`, commits, pushes, and autopilot relaunches with `--resume`
   - `exit-stuck` → halt; human attention required
4. **Worker** — if `next_skill === "work"`, a full-permission session picks
   one concrete chunk of outstanding work, implements it end-to-end, tests
   it, commits, and pushes.
5. **Sticky model fallback** — Claude defaults to **Opus 4.7 → Sonnet 4.6**;
   Codex defaults to **GPT-5.5 → GPT-5.4**. The judge / worker downgrade on
   quota errors, but eval and orchestrator are **strong-only** — these
   decision points are too important to silently downgrade.
6. **Repeat** until the judge AND eval both pass.

Legacy statistical stagnation detection is still available behind
`--no-orchestrator` for parity, but the orchestrator skill subsumes it
dynamically by default.

The worker is explicitly instructed to **never** ask clarifying questions — it
spawns subagents or hits the web instead. All configured MCP servers are
inherited automatically.

## Install

```bash
git clone https://github.com/shyDaniel/agent-autopilot
cd agent-autopilot
npm install
npm run build
npm link   # exposes `autopilot` on your PATH
```

Requires:

- Node.js ≥ 20
- Claude mode: `ANTHROPIC_API_KEY` or an already-authenticated Claude Code login
- Codex mode: Codex CLI authenticated via `codex login`
- `git` and (optionally) `gh` for remote pushes

### Optional MCPs

The framework ships `playwright` and `chrome-devtools` MCPs for free —
they need no credentials. `browserbase` (multi-session real-browser
validation, e.g. for matchmaking / multi-user flows) is enabled only
when both env vars below are set:

```bash
export BROWSERBASE_API_KEY=<your-key>         # https://browserbase.com/settings
export BROWSERBASE_PROJECT_ID=<your-project-uuid>
```

If either is missing, autopilot prints `browserbase MCP disabled — set
BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID to enable multi-session
browser validation` once at startup and continues with playwright /
chrome-devtools only. **No credentials are ever hardcoded in the
shipped package** — bring your own.

## Usage

```bash
# drive the current directory until judge says done
autopilot run .

# drive with Codex instead of Claude Code
autopilot run . --agent codex

# same thing through the Codex-default bin
codex-autopilot run .

# drive a specific repo
autopilot ~/projects/my-saas

# cap iterations, disable stagnation detector, skip pushing
autopilot run . --max-iterations 50 --no-stagnation --no-push

# just run the judge once and exit
autopilot run . --dry-run

# resume after a crash
autopilot run . --resume

# pick specific models + fallbacks
autopilot run . \
  --worker-model claude-opus-4-7 --worker-fallback-model claude-sonnet-4-6 \
  --judge-model claude-opus-4-7  --judge-fallback-model claude-sonnet-4-6

# pick specific Codex models + fallbacks
codex-autopilot run . \
  --worker-model gpt-5.5 --worker-fallback-model gpt-5.4 \
  --judge-model gpt-5.5  --judge-fallback-model gpt-5.4

# disable the self-refinement meta-loop (default: on)
autopilot run . --no-auto-refine

# cap self-refinement budget per run (default 3)
autopilot run . --max-refinements 5

# explicit autopilot source path (default: auto-detected from import.meta.url)
autopilot run . --autopilot-source /path/to/agent-autopilot
```

### Email alerts on big events (optional)

Autopilot sends email on four **big** events only — nothing per-iteration,
so it will not spam:

| Kind              | When                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `done`            | Judge flips `done: true` — the project is shipped                   |
| `big-progress`    | Outstanding list drops ≥ 50% vs baseline + ≥ 3 absolute, OR ≥ 5 closed in one iteration |
| `self-refined`    | Stagnation triggered meta-refinement and autopilot successfully relaunched |
| `needs-attention` | Refinement failed or auto-refine disabled — human intervention required |

Throttled at 10 min per kind. Configured via the same env vars as
`../news-alerter`'s Gmail SMTP mailer — set these in your shell before
running `autopilot`:

```bash
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=you@gmail.com
export SMTP_PASSWORD=<google-app-password>
export EMAIL_FROM=you@gmail.com
export EMAIL_TO=you@gmail.com
```

If you already have news-alerter's `.env` populated, reuse it:
`export $(grep -v '^#' /home/hanyu/projects/news-alerter/.env | xargs)`.

Pass `--no-email` to disable even when env vars are set.

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

# structured graph of the most recent run (terminal / --markdown / --json)
autopilot report <repo>
autopilot report <repo> --live          # redraws on every events.jsonl write

# triage: health verdict + anomaly flags + recommendations
autopilot diagnose <repo>
autopilot diagnose <repo> --watch       # dashboard for long-running runs
autopilot diagnose <repo> --json        # for scripts / CI gates
```

The surveillance commands read from files under `<repo>/.autopilot/`, so they
work whether the main loop is still running, crashed, or finished.

`autopilot diagnose` runs a fixed ruleset over the events stream + state +
status files and surfaces:

| Rule | Severity | Catches |
|---|---|---|
| `stale_process` | critical | pid alive but no events for > 5 min |
| `judge_unparseable_rate` | warn | judge returned no parseable verdict in > 15% of last 10 iters |
| `iter_time_outlier` | info | iteration ran > 3× median (and > 30 min absolute) |
| `sdk_error_cluster` | warn | ≥ 3 `Claude Code process exited with code 1` in last hour |
| `evolve_storm` | warn | 3+ refinements within 30 min — structural fix may be warranted |
| `worker_noop_pattern` | warn | worker ran but landed 0 commits in ≥ 2 of last 5 iters |
| `stagnation_with_progress` | warn | outstanding count stable for 4 iters even though commits land |
| `relaunch_storm` | info | autopilot has re-execed ≥ 5 times this run |

The matching `skills/diagnose/SKILL.md` lets an LLM agent (invoked via "is this
run stuck?" or similar) layer narrative on top of the deterministic flags.

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
3. **The worker prompt is too soft** on a specific failure mode.
4. **A brittle external dependency** (test flake, rate limit) keeps undoing
   progress.

The written `.autopilot/STAGNATION_REPORT.md` lists these hypotheses against
the recent history so you have a starting point.

### Self-refinement (on by default)

When stagnation fires, autopilot doesn't just exit — it spawns a fresh Claude
Code or Codex session in the autopilot source repo with the stagnation report
and the recent worker transcripts as context. That session's mandate: diagnose why
autopilot got stuck and edit autopilot's own source (typically
`src/prompts.ts` or `src/metrics.ts`) to fix it. It must make tests + build
pass before committing, then pushes.

Autopilot then runs `npm install && npm run build` on the (now refined)
source, and spawns a fresh `autopilot run <target> --resume` as a child
process that inherits stdio. The target run continues with the new binary,
bounded by `--max-refinements` (default 3).

This only activates when autopilot can find a writable git checkout of its
own source via `import.meta.url`. If it's installed read-only from a
registry, auto-refine is skipped and autopilot exits 3. You can always
override with `--autopilot-source <path>`.

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

`autopilot run` executes Claude Code with `permissionMode: 'bypassPermissions'`
or Codex with `codex exec --dangerously-bypass-approvals-and-sandbox`. It edits
files, runs arbitrary shell commands, installs packages, and pushes to `origin`
without asking. **This is the whole point of the tool.** Do not run it against a
repo you are not willing to see modified autonomously. Run inside a sandbox,
container, or throwaway worktree if unsure.

`autopilot status` / `watch` / `log` are read-only and safe to run any time.

## License

MIT.
