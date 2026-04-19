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
} from './metrics.js';
import { writeIterationArtifacts, writeStagnationReport } from './artifacts.js';
import {
  DEFAULT_JUDGE_MODELS,
  DEFAULT_WORKER_MODELS,
  ModelSelector,
  type ModelPreference,
} from './model.js';
import {
  detectAutopilotSource,
  relaunchAutopilot,
  runMetaRefinement,
  writeRefinementFailureNote,
} from './commands/refine.js';
import {
  Notifier,
  evaluateBigProgress,
  loadNotifierConfig,
  type BigProgressState,
} from './notifier.js';

export interface AutopilotOptions {
  repo: string;
  maxIterations?: number;
  workerModels: ModelPreference;
  judgeModels: ModelPreference;
  noPush: boolean;
  dryRun: boolean;
  resume: boolean;
  judgeMaxTurns?: number;
  workerMaxTurns?: number;
  stagnationThreshold: number;
  stagnationDisabled: boolean;
  autoRefine: boolean;
  autopilotSource?: string;
  maxRefinements: number;
  emailDisabled: boolean;
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

  const notifier = new Notifier(loadNotifierConfig(opts.emailDisabled));
  const bigProgressState: BigProgressState = { baseline: null, prev: null };
  if (notifier.enabled) log.info(`email alerts: on (to ${process.env.EMAIL_TO || process.env.SMTP_USER})`);
  else log.info('email alerts: off (set SMTP_USER + SMTP_PASSWORD env to enable)');

  const workerSelector = new ModelSelector(opts.workerModels, 'worker', async (from, to, reason) => {
    log.warn(`worker: falling back ${from} → ${to} (${reason.slice(0, 120)}…)`);
    await events.emit({
      iter: state.iteration,
      phase: 'worker',
      kind: 'error',
      msg: `fallback ${from} → ${to}`,
      data: { from, to, reason },
    });
  });
  const judgeSelector = new ModelSelector(opts.judgeModels, 'judge', async (from, to, reason) => {
    log.warn(`judge: falling back ${from} → ${to} (${reason.slice(0, 120)}…)`);
    await events.emit({
      iter: state.iteration,
      phase: 'judge',
      kind: 'error',
      msg: `fallback ${from} → ${to}`,
      data: { from, to, reason },
    });
  });

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
      workerModels: opts.workerModels,
      judgeModels: opts.judgeModels,
      autoRefine: opts.autoRefine,
      maxRefinements: opts.maxRefinements,
      refinementsSoFar: state.refinementsSoFar,
    },
  });

  log.banner(`claude-autopilot @ ${repo}`);
  log.info(
    `pid=${process.pid}  resume=${opts.resume}  maxIter=${opts.maxIterations ?? '∞'}  noPush=${opts.noPush}  dryRun=${opts.dryRun}  stagThreshold=${opts.stagnationThreshold}${opts.stagnationDisabled ? ' (disabled)' : ''}  autoRefine=${opts.autoRefine}`,
  );
  log.info(
    `models: worker=${opts.workerModels.primary} (fallback ${opts.workerModels.fallback})  judge=${opts.judgeModels.primary} (fallback ${opts.judgeModels.fallback})`,
  );
  if (state.iteration > 0) log.info(`resuming from iteration ${state.iteration} (refinements so far: ${state.refinementsSoFar})`);

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
      log.step(`judge: evaluating repo state (model=${judgeSelector.current()})`);
      verdict = await runJudge({
        repoPath: repo,
        iteration: state.iteration,
        selector: judgeSelector,
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
      await notifier.sendImmediate(
        'done',
        `[autopilot] SHIPPED: ${repo}`,
        `The judge has confirmed FINAL_GOAL.md is fully satisfied after ${state.iteration} iteration${state.iteration === 1 ? '' : 's'}.\n\nRepo: ${repo}\nFinished: ${new Date().toISOString()}\nTotal commits this run: ${afterSnapCount(initialSnap, snapshotRepo(repo))}\n\nVerdict summary:\n${verdict.summary}\n`,
      );
      break;
    }

    // Big-progress detection BEFORE updating bigProgressState.prev.
    const bp = evaluateBigProgress(bigProgressState, verdict.outstanding.length);
    if (bp.alert && bigProgressState.prev !== null) {
      await notifier.send(
        'big-progress',
        `[autopilot] big progress on ${nameFromPath(repo)}: ${bp.from} → ${bp.to} outstanding`,
        `Autopilot made a meaningful leap on ${repo} at iteration ${state.iteration}.\n\n` +
          `Outstanding items: ${bp.from} → ${bp.to} (${bp.reason === 'one-shot' ? 'single-iteration drop' : 'cumulative halving'})\n\n` +
          `Current judge summary:\n${verdict.summary}\n\n` +
          `Remaining:\n${verdict.outstanding.slice(0, 10).map((b) => '  - ' + b).join('\n')}${verdict.outstanding.length > 10 ? '\n  … and ' + (verdict.outstanding.length - 10) + ' more' : ''}\n`,
      );
      bigProgressState.baseline = verdict.outstanding.length;
    } else if (bigProgressState.baseline === null) {
      bigProgressState.baseline = verdict.outstanding.length;
    }
    bigProgressState.prev = verdict.outstanding.length;

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
      log.step(`worker: making progress (model=${workerSelector.current()})`);
      const result = await runWorker({
        repoPath: repo,
        iteration: state.iteration,
        outstandingSummary: verdict.summary,
        outstandingBullets: verdict.outstanding,
        noPush: opts.noPush,
        selector: workerSelector,
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
        const reason = stag.reason ?? 'stagnant';
        const reportPath = await writeStagnationReportFull(repo, state, history, opts, reason);
        await events.emit({
          iter: state.iteration,
          phase: 'loop',
          kind: 'stagnation',
          msg: reason,
          data: { report: reportPath },
        });
        await status.update({
          phase: 'stopped',
          stopReason: 'stagnant',
          stopMessage: reason,
          currentAction: undefined,
        });
        log.err(`STAGNATION: ${reason}`);
        log.info(`report: ${reportPath}`);

        if (opts.autoRefine) {
          const autopilotSource = opts.autopilotSource ?? detectAutopilotSource();
          if (!autopilotSource) {
            log.err('auto-refine enabled but autopilot source not found (not a git checkout of claude-autopilot); exit 3');
            exitCode = 3;
            break;
          }
          if (state.refinementsSoFar >= opts.maxRefinements) {
            log.err(`auto-refine budget exhausted (${state.refinementsSoFar}/${opts.maxRefinements}); exit 3`);
            exitCode = 3;
            break;
          }

          // Use a FRESH selector for refinement so a sticky worker downgrade
          // doesn't automatically force the meta-agent to a weaker model.
          const refineSelector = new ModelSelector(opts.workerModels, 'worker');
          const r = await runMetaRefinement({
            autopilotSource,
            targetRepo: repo,
            stagnationReportPath: reportPath,
            refinementsSoFar: state.refinementsSoFar,
            maxRefinements: opts.maxRefinements,
            selector: refineSelector,
            events,
          });

          if (r.success) {
            state.refinementsSoFar += 1;
            await saveState(repo, state);
            log.ok('refinement committed; relaunching autopilot with --resume');
            await notifier.sendImmediate(
              'self-refined',
              `[autopilot] self-refined: ${nameFromPath(repo)} (refinement #${state.refinementsSoFar})`,
              `Autopilot detected stagnation on ${repo} and successfully refined its own source.\n\n` +
                `Autopilot commit: ${r.preHeadSha?.slice(0, 7)} → ${r.postHeadSha?.slice(0, 7)}\n` +
                `Refinements so far this run: ${state.refinementsSoFar} / ${opts.maxRefinements}\n` +
                `Transcript: ${r.transcriptPath}\n\n` +
                `Stagnation reason: ${reason}\n\n` +
                `Autopilot is now relaunching against the target with --resume.\n`,
            );
            exitCode = await relaunchAutopilot();
            break;
          } else {
            await writeRefinementFailureNote(repo, r.reason ?? 'unknown');
            log.err(`refinement failed: ${r.reason}`);
            await notifier.sendImmediate(
              'needs-attention',
              `[autopilot] stuck: ${nameFromPath(repo)} needs you`,
              `Autopilot halted on ${repo} and a refinement attempt also failed — human attention required.\n\n` +
                `Iteration: ${state.iteration}\n` +
                `Stagnation reason: ${reason}\n` +
                `Refinement failure: ${r.reason}\n` +
                `Refinements attempted: ${state.refinementsSoFar} / ${opts.maxRefinements}\n\n` +
                `Stagnation report: ${reportPath}\n` +
                `Events log: ${repo}/.autopilot/events.jsonl\n`,
            );
            exitCode = 3;
            break;
          }
        } else {
          await notifier.sendImmediate(
            'needs-attention',
            `[autopilot] stuck: ${nameFromPath(repo)} needs you`,
            `Autopilot halted on ${repo} and auto-refine is disabled.\n\n` +
              `Iteration: ${state.iteration}\n` +
              `Stagnation reason: ${reason}\n` +
              `Stagnation report: ${reportPath}\n`,
          );
          exitCode = 3;
          break;
        }
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

async function writeStagnationReportFull(
  repo: string,
  state: AutopilotState,
  history: IterationSnapshot[],
  opts: AutopilotOptions,
  reason: string,
): Promise<string> {
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
    `- Refinements attempted so far: ${state.refinementsSoFar}`,
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
    'Typical root causes, in order of likelihood:',
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
    '   undoing progress. Inspect recent `worker-transcript.md` files.',
    '',
    'Artifacts for every iteration are under `.autopilot/iterations/`.',
    '',
  ].join('\n');

  return await writeStagnationReport(repo, body);
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

function nameFromPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function afterSnapCount(before: { commitCountTotal: number }, after: { commitCountTotal: number }): number {
  return Math.max(0, after.commitCountTotal - before.commitCountTotal);
}

// re-export defaults for CLI consumption
export { DEFAULT_WORKER_MODELS, DEFAULT_JUDGE_MODELS };
