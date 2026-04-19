import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { log } from './logging.js';
import { runJudge, type Verdict } from './judge.js';
import { runWorker } from './worker.js';
import { freshState, loadState, saveState, type AutopilotState } from './state.js';
import { EventLog } from './events.js';
import { StatusWriter } from './status.js';
import {
  detectStagnation,
  snapshotRepo,
  type IterationSnapshot,
  type RepoMetrics,
} from './metrics.js';
import { writeIterationArtifacts, writeStagnationReport } from './artifacts.js';

export interface AutopilotOptions {
  repo: string;
  maxIterations?: number;
  workerModel?: string;
  judgeModel?: string;
  noPush: boolean;
  dryRun: boolean;
  resume: boolean;
  judgeMaxTurns?: number;
  workerMaxTurns?: number;
  stagnationThreshold: number;
  stagnationDisabled: boolean;
}

const BASE_BACKOFF_MS = 4_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export async function runAutopilot(opts: AutopilotOptions): Promise<number> {
  const repo = resolve(opts.repo);
  if (!existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);

  let state: AutopilotState = opts.resume ? ((await loadState(repo)) ?? freshState()) : freshState();

  const events = new EventLog(repo);
  const initialSnap = snapshotRepo(repo);
  const status = new StatusWriter(repo, {
    repo,
    pid: process.pid,
    startedAt: state.startedAt,
    iteration: state.iteration,
    phase: 'starting',
    stagnantIterations: 0,
    stagnationThreshold: opts.stagnationThreshold,
    maxIterations: opts.maxIterations ?? null,
    commitsSinceStart: 0,
  });
  await status.update({});
  await events.emit({
    iter: 0,
    phase: 'loop',
    kind: 'start',
    msg: `autopilot pid=${process.pid}`,
    data: {
      repo,
      resume: opts.resume,
      maxIterations: opts.maxIterations ?? null,
      stagnationThreshold: opts.stagnationThreshold,
      stagnationDisabled: opts.stagnationDisabled,
    },
  });

  log.banner(`claude-autopilot @ ${repo}`);
  log.info(
    `pid=${process.pid}  resume=${opts.resume}  maxIterations=${opts.maxIterations ?? '∞'}  noPush=${opts.noPush}  dryRun=${opts.dryRun}  stagnationThreshold=${opts.stagnationThreshold}${opts.stagnationDisabled ? ' (disabled)' : ''}`,
  );
  if (state.iteration > 0) log.info(`resuming from iteration ${state.iteration}`);

  const stopHandler = async (reason: 'interrupted'): Promise<void> => {
    await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: reason });
    await status.update({ phase: 'stopped', stopReason: reason, currentAction: undefined });
  };
  process.on('SIGINT', () => void stopHandler('interrupted').then(() => process.exit(130)));
  process.on('SIGTERM', () => void stopHandler('interrupted').then(() => process.exit(143)));

  const history: IterationSnapshot[] = [];
  let consecutiveErrors = 0;
  let exitCode = 0;

  while (true) {
    if (opts.maxIterations !== undefined && state.iteration >= opts.maxIterations) {
      log.warn(`reached --max-iterations=${opts.maxIterations}; stopping`);
      await status.update({ phase: 'stopped', stopReason: 'max_iterations' });
      await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: 'max_iterations' });
      exitCode = 2;
      break;
    }

    state.iteration += 1;
    log.banner(`Iteration ${state.iteration}`);
    await status.update({ iteration: state.iteration, phase: 'judging', currentAction: undefined });
    await events.emit({ iter: state.iteration, phase: 'loop', kind: 'start' });

    const iterStart = Date.now();
    const beforeSnap = snapshotRepo(repo);

    let verdict: Verdict;
    try {
      log.step('judge: evaluating repo state');
      verdict = await runJudge({
        repoPath: repo,
        iteration: state.iteration,
        model: opts.judgeModel,
        maxTurns: opts.judgeMaxTurns,
        events,
        status,
      });
    } catch (err) {
      consecutiveErrors += 1;
      state.errors.push({ at: new Date().toISOString(), message: `judge: ${(err as Error).message}` });
      await saveState(repo, state);
      await backoff(consecutiveErrors, err as Error);
      continue;
    }

    state.lastVerdict = { ...verdict, at: new Date().toISOString() };
    await saveState(repo, state);
    await status.update({
      lastVerdict: {
        done: verdict.done,
        summary: verdict.summary,
        outstandingCount: verdict.outstanding.length,
        at: state.lastVerdict.at,
      },
    });

    if (verdict.done) {
      log.ok('JUDGE VERDICT: done. FINAL_GOAL.md fully satisfied.');
      log.info(verdict.summary);
      await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: 'done' });
      await status.update({ phase: 'stopped', stopReason: 'done', currentAction: undefined });
      break;
    }

    log.info(`outstanding: ${truncate(verdict.summary, 240)}`);
    for (const b of verdict.outstanding.slice(0, 8)) log.dim(`  - ${b}`);

    if (opts.dryRun) {
      log.warn('dry-run: skipping worker');
      await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: 'dry_run' });
      await status.update({ phase: 'stopped', stopReason: 'done', stopMessage: 'dry-run' });
      break;
    }

    await status.update({ phase: 'working', currentAction: undefined });

    let workerTranscript = '';
    try {
      log.step('worker: making progress');
      const result = await runWorker({
        repoPath: repo,
        iteration: state.iteration,
        outstandingSummary: verdict.summary,
        outstandingBullets: verdict.outstanding,
        noPush: opts.noPush,
        model: opts.workerModel,
        maxTurns: opts.workerMaxTurns,
        events,
        status,
      });
      workerTranscript = result.transcript;
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      state.errors.push({ at: new Date().toISOString(), message: `worker: ${(err as Error).message}` });
      await saveState(repo, state);
      await backoff(consecutiveErrors, err as Error);
      continue;
    }

    const afterSnap = snapshotRepo(repo);
    const newCommits = afterSnap.commitCountTotal - beforeSnap.commitCountTotal;
    if (newCommits > 0) {
      await events.emit({
        iter: state.iteration,
        phase: 'loop',
        kind: 'commit',
        msg: `+${newCommits} commit${newCommits === 1 ? '' : 's'}`,
        data: { before: beforeSnap.headSha, after: afterSnap.headSha },
      });
    }

    const iterDir = await writeIterationArtifacts(repo, {
      iter: state.iteration,
      verdict,
      workerTranscript,
      before: beforeSnap,
      after: afterSnap,
      durationMs: Date.now() - iterStart,
    });
    log.dim(`  artifacts: ${iterDir}`);

    history.push({
      iter: state.iteration,
      outstanding: verdict.outstanding,
      outstandingSummary: verdict.summary,
      headSha: afterSnap.headSha,
      commitCountTotal: afterSnap.commitCountTotal,
    });
    await status.update({
      commitsSinceStart: afterSnap.commitCountTotal - initialSnap.commitCountTotal,
    });

    await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end' });

    if (!opts.stagnationDisabled) {
      const stag = detectStagnation(history, opts.stagnationThreshold);
      const stagnant = countTrailingStagnant(history, opts.stagnationThreshold);
      await status.update({ stagnantIterations: stagnant });
      if (stag.stagnant) {
        await onStagnation(repo, state, history, opts, events, status, stag.reason ?? 'stagnant');
        exitCode = 3;
        break;
      }
    }

    await sleep(1000);
  }

  return exitCode;
}

function countTrailingStagnant(history: IterationSnapshot[], threshold: number): number {
  let count = 0;
  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i].outstanding.map((x) => x.toLowerCase().trim()).sort().join('|');
    const b = history[i - 1].outstanding.map((x) => x.toLowerCase().trim()).sort().join('|');
    const sameCommits = history[i].commitCountTotal === history[i - 1].commitCountTotal;
    if (a === b && sameCommits) count += 1;
    else break;
  }
  return Math.min(count, threshold);
}

async function onStagnation(
  repo: string,
  state: AutopilotState,
  history: IterationSnapshot[],
  opts: AutopilotOptions,
  events: EventLog,
  status: StatusWriter,
  reason: string,
): Promise<void> {
  const recent = history.slice(-Math.min(history.length, opts.stagnationThreshold + 1));
  const body = [
    '# STAGNATION_REPORT',
    '',
    `Autopilot halted at iteration ${state.iteration} because: **${reason}**.`,
    '',
    `- Repo: \`${repo}\``,
    `- Started: ${state.startedAt}`,
    `- Detected: ${new Date().toISOString()}`,
    `- Threshold: ${opts.stagnationThreshold}`,
    '',
    '## Recent iterations',
    '',
    ...recent.map((h) => {
      const lines = [`### Iteration ${h.iter}`, '', `HEAD: \`${h.headSha ?? 'n/a'}\``, `Commits total: ${h.commitCountTotal}`, '', 'Outstanding:'];
      for (const b of h.outstanding) lines.push(`- ${b}`);
      if (h.outstanding.length === 0) lines.push('- (none reported)');
      lines.push('');
      return lines.join('\n');
    }),
    '## What to refine',
    '',
    'If the same outstanding items keep appearing without progress, one of:',
    '',
    '1. **FINAL_GOAL.md is under-specified** — the judge keeps finding the',
    '   same gap because the acceptance criteria do not pin down what "done"',
    '   means. Tighten the wording and re-run.',
    '2. **The worker lacks a tool/MCP** needed to complete the work. Check',
    '   `.autopilot/events.jsonl` for `tool` events — if the worker never',
    '   attempts the relevant operation, it may not have the capability.',
    '3. **The worker prompt is too soft** on a specific failure mode. Edit',
    '   `src/prompts.ts` in the autopilot repo and re-run.',
    '4. **A brittle external dependency** (test flake, network) keeps',
    '   undoing progress. Inspect recent iteration `worker-transcript.md`',
    '   files under `.autopilot/iterations/`.',
    '',
    'Artifacts for every iteration are under `.autopilot/iterations/`.',
    '',
  ].join('\n');

  const p = await writeStagnationReport(repo, body);
  await events.emit({
    iter: state.iteration,
    phase: 'loop',
    kind: 'stagnation',
    msg: reason,
    data: { report: p },
  });
  await status.update({
    phase: 'stopped',
    stopReason: 'stagnant',
    stopMessage: reason,
    currentAction: undefined,
  });
  log.err(`STAGNATION: ${reason}`);
  log.info(`report: ${p}`);
}

async function backoff(attempt: number, err: Error): Promise<void> {
  const ms = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  log.err(`${err.message}`);
  log.warn(`backing off ${Math.round(ms / 1000)}s before retry (attempt ${attempt})`);
  await sleep(ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
