import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { log } from './logging.js';
import { runJudge, type Verdict } from './judge.js';
import { runWorker } from './worker.js';
import { freshState, loadState, saveState, type AutopilotState } from './state.js';

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
}

const BASE_BACKOFF_MS = 4_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export async function runAutopilot(opts: AutopilotOptions): Promise<void> {
  const repo = resolve(opts.repo);
  if (!existsSync(repo)) {
    throw new Error(`Repo path does not exist: ${repo}`);
  }

  let state: AutopilotState = opts.resume ? ((await loadState(repo)) ?? freshState()) : freshState();
  log.banner(`claude-autopilot @ ${repo}`);
  log.info(`resume=${opts.resume}  maxIterations=${opts.maxIterations ?? '∞'}  noPush=${opts.noPush}  dryRun=${opts.dryRun}`);
  if (state.iteration > 0) log.info(`resuming from iteration ${state.iteration}`);

  let consecutiveErrors = 0;

  while (true) {
    if (opts.maxIterations !== undefined && state.iteration >= opts.maxIterations) {
      log.warn(`reached --max-iterations=${opts.maxIterations}; stopping`);
      break;
    }
    state.iteration += 1;
    log.banner(`Iteration ${state.iteration}`);

    let verdict: Verdict;
    try {
      log.step('judge: evaluating repo state');
      verdict = await runJudge({
        repoPath: repo,
        model: opts.judgeModel,
        maxTurns: opts.judgeMaxTurns,
      });
    } catch (err) {
      consecutiveErrors += 1;
      await backoff(consecutiveErrors, err as Error);
      state.errors.push({ at: new Date().toISOString(), message: `judge: ${(err as Error).message}` });
      await saveState(repo, state);
      continue;
    }

    state.lastVerdict = { ...verdict, at: new Date().toISOString() };
    await saveState(repo, state);

    if (verdict.done) {
      log.ok('JUDGE VERDICT: done. FINAL_GOAL.md fully satisfied.');
      log.info(verdict.summary);
      break;
    }

    log.info(`outstanding: ${truncate(verdict.summary, 240)}`);
    for (const b of verdict.outstanding.slice(0, 8)) log.dim(`  - ${b}`);

    if (opts.dryRun) {
      log.warn('dry-run: skipping worker');
      break;
    }

    try {
      log.step('worker: making progress');
      await runWorker({
        repoPath: repo,
        iteration: state.iteration,
        outstandingSummary: verdict.summary,
        outstandingBullets: verdict.outstanding,
        noPush: opts.noPush,
        model: opts.workerModel,
        maxTurns: opts.workerMaxTurns,
      });
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      state.errors.push({ at: new Date().toISOString(), message: `worker: ${(err as Error).message}` });
      await saveState(repo, state);
      await backoff(consecutiveErrors, err as Error);
      continue;
    }

    await saveState(repo, state);
    await sleep(1000);
  }
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
