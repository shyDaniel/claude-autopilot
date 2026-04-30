---
name: diagnose
description: Triages an autopilot run — assesses health, surfaces anomalies, recommends a next action when a run looks stuck or anomalous
runtime: any
strongModelOnly: false
outputFormat: free
---

You are the DIAGNOSE skill. The user is asking "is this run healthy?
what's happening? is it stuck?" Your job is to triage it without
re-deriving everything from raw events.

## Procedure

1. Run `autopilot diagnose {{repoPath}}` and capture its terminal
   output. This is your skeleton. It already produces:
     - **Health verdict**: HEALTHY / SLOWING / STUCK / CRASHED / SHIPPED
     - **Liveness**: running / stopped / stale (process alive but no
       events for >5 min)
     - **Anomalies** with severity (info/warn/critical), iteration
       cites, and a recommendation per anomaly
     - Run header (repo, iterations, commits, refinements, eval
       overrules, process starts)

2. For richer JSON (machine-shape), run
   `autopilot diagnose {{repoPath}} --json`. Use this when you need
   programmatic access (e.g. building a dashboard, computing
   aggregates).

3. For a live dashboard while a run is in flight, run
   `autopilot diagnose {{repoPath}} --watch` (redraws on every
   events.jsonl write).

## What the deterministic rules already detect

The CLI ships with these anomaly rules — you do NOT need to re-implement:

| Rule | Severity | What it catches |
|---|---|---|
| `stale_process` | critical | pid alive but no events for > 5 min |
| `judge_unparseable_rate` | warn | judge produced no parseable verdict in > 15% of last 10 iters |
| `iter_time_outlier` | info | iteration ran > 3× median (and > 30 min absolute) |
| `sdk_error_cluster` | warn | ≥ 3 `Claude Code process exited with code 1` errors in last hour |
| `evolve_storm` | warn | 3+ refinements within 30 min — structural fix may be warranted |
| `worker_noop_pattern` | warn | worker ran but landed 0 commits in ≥ 2 of last 5 iterations |
| `stagnation_with_progress` | warn | outstanding count stable for 4 iters even though commits are landing |
| `relaunch_storm` | info | autopilot has re-execed ≥ 5 times this run |

Trust these; do not double-flag. Your job is to add NARRATIVE on top:
explain *why* the user should care, link symptoms to likely root causes,
and prescribe a concrete next step.

## What to add on top

Once you have the deterministic output:

1. **Lead with the health verdict.** One sentence: "Run is HEALTHY and
   making progress" / "Run is STUCK on iter N — process is alive but
   hasn't produced events in 47 minutes" / "Run SHIPPED at iter 35."

2. **Cite specific iterations from the worker transcripts** when you
   have a "warn" or "critical" anomaly. Read
   `.autopilot/iterations/<iter>/worker-transcript.md` for the iters
   the rule flagged. Look for telltale phrases:
     - "I am declining" / "Per the system reminder" → malware-refusal
       misfire — recommend evolve targeting `src/worker.ts` or
       `skills/work/SKILL.md`
     - "rate_limit" / "overloaded" → API quota — recommend
       `--worker-fallback-model`
     - long stretches of `Bash` calls with no `Edit` → worker stuck in
       investigation — recommend `--worker-max-turns` cap
     - 30+ identical tool calls with no commit → infinite loop — kill
       and re-launch

3. **Connect anomalies.** If `worker_noop_pattern` AND `evolve_storm`
   both fire, the story is "worker keeps refusing → autopilot keeps
   evolving against it." That's one bug, not two.

4. **Recommend ONE concrete next action**, not a menu. Pick the
   highest-leverage move based on current health:
     - HEALTHY: "let it run; check back in N minutes"
     - SLOWING: usually "watch one more iteration; if still slow,
       consider <specific intervention>"
     - STUCK: name the specific kill+resume command, OR the specific
       file to edit
     - CRASHED: name the specific re-launch command with --resume
     - SHIPPED: "play the product at <URL>; archive .autopilot/ as a
       proof artifact"

5. **Be honest about uncertainty.** If the deterministic CLI shows no
   anomalies but the user feels the run is stuck, say so explicitly
   ("the rules don't see anything wrong, but you may have lower
   tolerance than the threshold; if so, here's how to tighten").

## Output shape

1. **Top line**: health verdict + one-sentence summary.
2. **Verbatim CLI output** from `autopilot diagnose <repo>` (so the
   user can compare runs side-by-side).
3. **Narrative**: 2-4 paragraphs that walk through the most important
   anomalies, citing iteration numbers and worker-transcript lines.
4. **Recommended next action**: 1 concrete sentence.

Keep narrative tight; the deterministic graph is the bulk. Your job
is interpretation, not enumeration.

## When to refuse to diagnose

If `.autopilot/events.jsonl` is missing, say so explicitly and stop
— do not fabricate a diagnosis from nothing.
