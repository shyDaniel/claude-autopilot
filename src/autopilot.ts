import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { log } from './logging.js';
import { runJudge, type Verdict } from './judge.js';
import { runWorker } from './worker.js';
import { runEval, type EvalVerdict } from './eval.js';
import { runOrchestrator } from './orchestrator.js';
import { freshState, loadState, saveState, type AutopilotState } from './state.js';
import { EventLog } from './events.js';
import { StatusWriter } from './status.js';
import {
  changedPathsBetween,
  detectStagnation,
  snapshotRepo,
  touchesAutopilotInternals,
  workingTreeStatus,
  type IterationSnapshot,
} from './metrics.js';
import { writeIterationArtifacts, writeStagnationReport } from './artifacts.js';
import {
  DEFAULT_JUDGE_MODELS,
  DEFAULT_WORKER_MODELS,
  ModelSelector,
  agentDisplayName,
  type AgentRuntime,
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
import { detectStartCmd, startService, type ServiceHandle } from './service.js';
import { printBanner, writeFinalReport } from './finalReport.js';
import { detectAvailableMcps, looksLikeWebApp, renderMcpSection, resolveMcpServers } from './mcp.js';
import {
  loadPlan,
  savePlan,
  reconcilePlan,
  pickNextSubtask,
  markExhaustedAsNeedsReframe,
  collectStuckSubtasks,
  renderStuckBrief,
  planSummary,
  renderSubtaskBrief,
  type Plan,
} from './planner.js';

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
  verbose: boolean;
  startCmd?: string;
  startOnDoneDisabled: boolean;
  maxSubtaskAttempts: number;
  runtime: AgentRuntime;
  /**
   * Disable the eval skill (the second-pass critic that overrides the
   * judge's done verdict). Default: enabled. Disable only for debug runs.
   */
  evalDisabled: boolean;
  /**
   * Disable the orchestrator skill (decides next-skill dynamically).
   * Default: enabled. When disabled, falls back to legacy stagnation-based
   * control flow.
   */
  orchestratorDisabled: boolean;
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

  // Print the product banner FIRST so it's the visible top-of-output.
  // Anything that touches MCP detection or notifier config can fire stderr
  // warnings (browserbase env missing, SMTP env missing, etc.) — those must
  // appear UNDER the banner, not above it. Previously: detect → log MCP +
  // email → events.emit start → banner, which left up to 3 lines of noise
  // above the product header.
  log.banner(`${opts.runtime === 'codex' ? 'codex-autopilot' : 'agent-autopilot'} @ ${repo}`);

  const isWebApp = looksLikeWebApp(repo);
  const availableMcps = detectAvailableMcps(repo);
  const mcpSection = renderMcpSection(availableMcps, isWebApp);
  const mcpServers = resolveMcpServers(repo);
  log.info(
    `MCPs injected into every session: ${Object.keys(mcpServers).sort().join(', ') || '(none)'}` +
      (isWebApp ? '  [web app detected]' : ''),
  );

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
  // Eval and orchestrator both use a strong-only selector — no fallback,
  // because these decision points are too important to silently downgrade.
  const evalSelector = new ModelSelector(
    { primary: opts.judgeModels.primary, fallback: opts.judgeModels.primary },
    'judge',
  );
  const orchestratorSelector = new ModelSelector(
    { primary: opts.judgeModels.primary, fallback: opts.judgeModels.primary },
    'judge',
  );

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
      runtime: opts.runtime,
    },
  });

  log.info(
    `agent=${agentDisplayName(opts.runtime)}  pid=${process.pid}  resume=${opts.resume}  maxIter=${opts.maxIterations ?? '∞'}  noPush=${opts.noPush}  dryRun=${opts.dryRun}  stagThreshold=${opts.stagnationThreshold}${opts.stagnationDisabled ? ' (disabled)' : ''}  autoRefine=${opts.autoRefine}`,
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
  let plan: Plan | null = await loadPlan(repo);
  let lastWorkedOnId: string | undefined = plan?.lastWorkedOnId;

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

    // If any subtask hit the retry ceiling on a previous iteration, it's
    // flagged needs_reframe. Hand those to the judge so it decomposes /
    // reframes / blocks them this round instead of just leaving them.
    const stuckSubtasks = plan ? collectStuckSubtasks(plan) : [];
    const stuckBrief = renderStuckBrief(stuckSubtasks);
    if (stuckSubtasks.length > 0) {
      log.info(`judge: ${stuckSubtasks.length} stuck subtask(s) will be sent for reframe`);
    }

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
        verbose: opts.verbose,
        availableMcps: mcpSection,
        isWebApp,
        stuckBrief: stuckBrief || undefined,
        mcpServers,
        runtime: opts.runtime,
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
      log.ok('JUDGE VERDICT: done. Running EVAL skill as second-pass critic…');
      log.info(verdict.summary);

      // Eval skill — adversarial second-pass critic. May overrule the judge
      // indefinitely (no cap) per design. Only when BOTH judge AND eval pass
      // does autopilot ship.
      let evalVerdict: EvalVerdict | null = null;
      if (!opts.evalDisabled) {
        await status.update({ phase: 'evaluating', currentAction: undefined });
        try {
          evalVerdict = await runEval({
            repoPath: repo,
            iteration: state.iteration,
            selector: evalSelector,
            events,
            status,
            verbose: opts.verbose,
            availableMcps: mcpSection,
            judgeVerdict: verdict,
            mcpServers,
            runtime: opts.runtime,
          });
        } catch (err) {
          log.err(`eval failed: ${(err as Error).message}; treating as not passed (will not ship)`);
          evalVerdict = {
            passed: false,
            summary: `Eval crashed: ${(err as Error).message}`,
            blockers: ['Eval crashed; re-run is needed before shipping.'],
          };
        }
      } else {
        log.warn('eval skill disabled (--no-eval); shipping on judge verdict alone');
        evalVerdict = { passed: true, summary: 'eval skipped via --no-eval', blockers: [] };
      }

      if (!evalVerdict.passed) {
        log.warn(`EVAL OVERRULED JUDGE: ${evalVerdict.blockers.length} blocker(s) — looping`);
        for (const b of evalVerdict.blockers.slice(0, 8)) log.dim(`  - ${b}`);
        // Treat eval blockers as the new outstanding work. Mutate verdict so
        // downstream plan-reconciliation + worker see the eval findings as
        // the authoritative outstanding list this iteration.
        verdict.done = false;
        verdict.summary = `EVAL OVERRULED JUDGE: ${evalVerdict.summary}`;
        verdict.outstanding = [...evalVerdict.blockers, ...verdict.outstanding];
        verdict.subtasks = [...(evalVerdict.subtasks ?? []), ...(verdict.subtasks ?? [])];
        state.lastVerdict = { ...verdict, at: new Date().toISOString() };
        await saveState(repo, state);
        await status.update({
          lastVerdict: {
            done: false,
            summary: verdict.summary,
            outstandingCount: verdict.outstanding.length,
            at: state.lastVerdict.at,
          },
        });
        // Fall through to the rest of the iteration (worker etc).
      } else {
        log.ok('EVAL VERDICT: passed. Project is genuinely shipped.');
        await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: 'done' });
        await status.update({ phase: 'stopped', stopReason: 'done', currentAction: undefined });

      let service: ServiceHandle | null = null;
      let serviceError: string | undefined;
      if (!opts.startOnDoneDisabled) {
        const cmd = opts.startCmd ?? detectStartCmd(repo);
        if (cmd) {
          try {
            service = await startService(repo, cmd);
            log.ok(`service started: ${service.cmd} (pid=${service.pid}, log=${service.logPath})`);
          } catch (err) {
            serviceError = `failed to start service (${cmd}): ${(err as Error).message}`;
            log.warn(serviceError);
          }
        } else {
          serviceError = 'no start command detected; pass --start-cmd "<cmd>" to enable';
          log.warn(serviceError);
        }
      }

      const report = await writeFinalReport({
        repoPath: repo,
        state,
        verdict,
        service,
        serviceError,
      });
      printBanner({
        repoPath: repo,
        state,
        verdict,
        service,
        serviceError,
        reportPath: report.path,
      });

      await notifier.sendImmediate(
        'done',
        `[autopilot] SHIPPED: ${repo}`,
        report.markdown,
      );
      break;
      }
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

    // Reconcile the persistent plan ledger with the latest verdict.
    plan = reconcilePlan(plan, verdict.outstanding, verdict.subtasks, state.iteration, lastWorkedOnId);
    // Exhausted subtasks flip to needs_reframe (NOT failed) — next judge
    // iteration is required to decompose/reframe/block them.
    const newlyStuck = markExhaustedAsNeedsReframe(plan, opts.maxSubtaskAttempts);
    const summary = planSummary(plan);
    log.info(
      `plan: ${summary.pending} pending · ${summary.in_progress} in_progress · ` +
        `${summary.completed} completed · ${summary.needs_reframe} needs_reframe · ` +
        `${summary.reframed} reframed · ${summary.blocked} blocked · ${summary.failed} failed ` +
        `(of ${summary.total})`,
    );
    if (newlyStuck.length > 0) {
      log.warn(`subtask(s) hit max attempts (${opts.maxSubtaskAttempts}) and will be sent to judge for reframe: ${newlyStuck.join(', ')}`);
      await events.emit({
        iter: state.iteration,
        phase: 'loop',
        kind: 'error',
        msg: `subtasks flipped to needs_reframe after ${opts.maxSubtaskAttempts} attempts: ${newlyStuck.join(', ')}`,
      });
    }

    const nextSubtask = pickNextSubtask(plan, opts.maxSubtaskAttempts);
    if (nextSubtask) {
      nextSubtask.status = 'in_progress';
      plan.lastWorkedOnId = nextSubtask.id;
      lastWorkedOnId = nextSubtask.id;
      log.step(`planner: next subtask ${nextSubtask.id} (attempt ${nextSubtask.attempts + 1}) — ${truncate(nextSubtask.text, 120)}`);
    } else {
      plan.lastWorkedOnId = undefined;
      lastWorkedOnId = undefined;
      if (summary.pending === 0 && summary.failed > 0) {
        log.err(`all pending subtasks exhausted retries; ${summary.failed} failed — waking stagnation path`);
      }
    }
    await savePlan(repo, plan);

    if (opts.dryRun) {
      log.warn('dry-run: skipping worker');
      await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: 'dry_run' });
      await status.update({ phase: 'stopped', stopReason: 'done', stopMessage: 'dry-run' });
      break;
    }

    // ORCHESTRATOR — decides which skill to run next given dynamic state.
    // Replaces the legacy statistical stagnation detector. The orchestrator
    // can dispatch: work | reframe | evolve | exit-stuck.
    let orchestratorChoice: 'work' | 'reframe' | 'evolve' | 'exit-stuck' = 'work';
    let orchestratorReason = '(orchestrator disabled)';
    if (!opts.orchestratorDisabled && state.iteration >= 2) {
      await status.update({ phase: 'orchestrating', currentAction: undefined });
      const orch = await runOrchestrator({
        repoPath: repo,
        iteration: state.iteration,
        runStartedAt: state.startedAt,
        selector: orchestratorSelector,
        events,
        status,
        verbose: opts.verbose,
        judgeVerdict: verdict,
        history,
        plan,
        refinementsSoFar: state.refinementsSoFar,
        maxRefinements: opts.maxRefinements,
        mcpServers,
        runtime: opts.runtime,
      });
      orchestratorChoice = orch.next_skill;
      orchestratorReason = orch.reason;
    }

    if (orchestratorChoice === 'exit-stuck') {
      log.err(`orchestrator: exit-stuck (${truncate(orchestratorReason, 200)})`);
      await events.emit({
        iter: state.iteration,
        phase: 'loop',
        kind: 'end',
        msg: 'orchestrator_exit_stuck',
        data: { reason: orchestratorReason },
      });
      await status.update({ phase: 'stopped', stopReason: 'stagnant', stopMessage: orchestratorReason });
      await notifier.sendImmediate(
        'needs-attention',
        `[autopilot] orchestrator stopped: ${nameFromPath(repo)} needs you`,
        `Orchestrator decided no further automated progress is possible.\n\nReason: ${orchestratorReason}\n\nIteration: ${state.iteration}\n`,
      );
      exitCode = 3;
      break;
    }

    if (orchestratorChoice === 'evolve') {
      log.warn(`orchestrator: evolve (${truncate(orchestratorReason, 200)})`);
      const triggerReportPath = await writeOrchestratorEvolveReport(
        repo,
        state.iteration,
        orchestratorReason,
        verdict,
      );
      await events.emit({
        iter: state.iteration,
        phase: 'loop',
        kind: 'stagnation',
        msg: 'orchestrator-evolve',
        data: { report: triggerReportPath, reason: orchestratorReason },
      });

      if (!opts.autoRefine) {
        log.err('orchestrator wants evolve but --no-auto-refine is set; exit 3');
        await notifier.sendImmediate(
          'needs-attention',
          `[autopilot] orchestrator wants evolve but it's disabled: ${nameFromPath(repo)}`,
          `Orchestrator: ${orchestratorReason}\nReport: ${triggerReportPath}\n`,
        );
        exitCode = 3;
        break;
      }

      const autopilotSource = opts.autopilotSource ?? detectAutopilotSource();
      if (!autopilotSource) {
        log.err('orchestrator wants evolve but autopilot source not found; exit 3');
        exitCode = 3;
        break;
      }
      if (state.refinementsSoFar >= opts.maxRefinements) {
        log.err(`auto-refine budget exhausted (${state.refinementsSoFar}/${opts.maxRefinements}); exit 3`);
        exitCode = 3;
        break;
      }

      await status.update({ phase: 'evolving', currentAction: undefined });
      const refineSelector = new ModelSelector(opts.workerModels, 'worker');
      const r = await runMetaRefinement({
        autopilotSource,
        targetRepo: repo,
        triggerReportPath,
        refinementsSoFar: state.refinementsSoFar,
        maxRefinements: opts.maxRefinements,
        selector: refineSelector,
        events,
        runtime: opts.runtime,
      });

      if (r.success) {
        state.refinementsSoFar += 1;
        await saveState(repo, state);
        log.ok('evolve committed; relaunching autopilot with --resume');
        await notifier.sendImmediate(
          'self-refined',
          `[autopilot] self-refined: ${nameFromPath(repo)} (refinement #${state.refinementsSoFar})`,
          `Orchestrator triggered evolve.\n\nAutopilot commit: ${r.preHeadSha?.slice(0, 7)} → ${r.postHeadSha?.slice(0, 7)}\nRefinements so far: ${state.refinementsSoFar} / ${opts.maxRefinements}\nTranscript: ${r.transcriptPath}\nReason: ${orchestratorReason}\n`,
        );
        exitCode = await relaunchAutopilot();
        break;
      } else {
        await writeRefinementFailureNote(repo, r.reason ?? 'unknown');
        log.err(`evolve failed: ${r.reason}`);
        await notifier.sendImmediate(
          'needs-attention',
          `[autopilot] evolve failed: ${nameFromPath(repo)} needs you`,
          `Orchestrator triggered evolve, but the refinement attempt failed.\n\nIteration: ${state.iteration}\nOrchestrator reason: ${orchestratorReason}\nRefinement failure: ${r.reason}\n`,
        );
        exitCode = 3;
        break;
      }
    }

    if (orchestratorChoice === 'reframe') {
      log.info(`orchestrator: reframe (${truncate(orchestratorReason, 200)}) — skipping worker, next iter judge will reframe`);
      // Skip the worker this iteration; next judge call will see the
      // stuck-subtask brief and reframe via JSON output.
      history.push({
        iter: state.iteration,
        outstanding: verdict.outstanding,
        outstandingSummary: verdict.summary,
        headSha: beforeSnap.headSha,
        commitCountTotal: beforeSnap.commitCountTotal,
      });
      await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end', msg: 'orchestrator-reframe' });
      await sleep(1000);
      continue;
    }

    // Default: orchestratorChoice === 'work' (or orchestrator disabled).
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
        verbose: opts.verbose,
        availableMcps: mcpSection,
        isWebApp,
        subtaskBrief: nextSubtask ? renderSubtaskBrief(nextSubtask) : undefined,
        mcpServers,
        runtime: opts.runtime,
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

    // Half-wired-tree detector. The iter-7 misfire on xiaodaoyiba-v2 was:
    // worker self-confirmed the repo benign, partially wrote 3 source files,
    // then refused mid-task citing the runtime malware-reminder, ending with
    // 0 commits and a dirty working tree. That outcome was indistinguishable
    // from "nothing happened" to autopilot, so the orchestrator burned the
    // last refinement slot on it. Surfacing the dirty-tree fact lets the
    // orchestrator dispatch `work` for an in-loop recovery instead of
    // `evolve`, and is the structural counterpart to the worker SKILL's
    // "Recovering an in-flight, half-wired tree" recovery procedure.
    let halfWired = false;
    if (newCommits === 0) {
      const wt = workingTreeStatus(repo);
      if (wt.dirty) {
        halfWired = true;
        const sample = [...wt.modifiedFiles, ...wt.untrackedFiles].slice(0, 8);
        const more = wt.modifiedFiles.length + wt.untrackedFiles.length - sample.length;
        log.warn(
          `worker ended with 0 commits but dirty tree (${wt.modifiedFiles.length} modified, ` +
            `${wt.untrackedFiles.length} untracked): ${sample.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
        );
        await events.emit({
          iter: state.iteration,
          phase: 'loop',
          kind: 'half-wired-tree',
          msg: `0 commits, ${wt.modifiedFiles.length}M ${wt.untrackedFiles.length}U`,
          data: {
            modifiedFiles: wt.modifiedFiles,
            untrackedFiles: wt.untrackedFiles,
          },
        });
      }
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
      halfWired,
    });
    await status.update({
      commitsSinceStart: afterSnap.commitCountTotal - initialSnap.commitCountTotal,
    });

    await events.emit({ iter: state.iteration, phase: 'loop', kind: 'end' });

    // Self-drive stale-dist guard. When autopilot is driving its own source
    // and the worker just committed changes that touch our internals
    // (src/, dist/, skills/, package.json, bin/), the running parent has the
    // pre-commit dist cached in Node's module loader — every subsequent
    // judge/worker/orchestrate call would silently use the OLD code. The
    // only honest fix is to re-exec (`relaunchAutopilot` + `--resume`) so
    // the child loads the fresh build. We rebuild first because the work
    // skill does not mandate `npm run build`; a broken build means we
    // refuse to relaunch, log loudly, and roll forward. This is the
    // textbook trigger called out in the orchestrator evolve report:
    // "after a worker commit touches src/, when target===autopilotSource,
    // call relaunchAutopilot so the freshly-built dist is actually loaded."
    if (newCommits > 0) {
      const detectedSource = opts.autopilotSource ?? detectAutopilotSource();
      const isSelfDrive = detectedSource !== null && resolve(detectedSource) === repo;
      if (isSelfDrive) {
        const changed = changedPathsBetween(repo, beforeSnap.headSha, afterSnap.headSha);
        if (touchesAutopilotInternals(changed)) {
          log.warn(
            `self-drive: worker commit touched autopilot internals (${changed
              .filter((p) => p.startsWith('src/') || p.startsWith('dist/') || p.startsWith('skills/') || p === 'package.json' || p === 'package-lock.json' || p.startsWith('bin/'))
              .slice(0, 6)
              .join(', ')}${changed.length > 6 ? ', …' : ''}); rebuilding and relaunching to pick up fresh dist`,
          );
          let buildOk = true;
          try {
            execFileSync('npm', ['run', 'build', '--silent'], {
              cwd: repo,
              stdio: 'inherit',
            });
          } catch (err) {
            buildOk = false;
            log.err(
              `self-drive rebuild failed: ${(err as Error).message}; refusing to relaunch (next iteration will roll forward against stale in-memory dist)`,
            );
            await events.emit({
              iter: state.iteration,
              phase: 'loop',
              kind: 'error',
              msg: `self-relaunch: build failed (${(err as Error).message})`,
            });
          }
          if (buildOk) {
            await saveState(repo, state);
            await events.emit({
              iter: state.iteration,
              phase: 'loop',
              kind: 'self-relaunch',
              msg: 'rebuilt; re-execing to pick up fresh dist',
              data: {
                before: beforeSnap.headSha,
                after: afterSnap.headSha,
                touchedPaths: changed.slice(0, 20),
              },
            });
            await status.update({ phase: 'stopped', stopReason: 'self_relaunch' });
            log.banner('SELF-RELAUNCH');
            exitCode = await relaunchAutopilot();
            return exitCode;
          }
        }
      }
    }

    if (!opts.stagnationDisabled && opts.orchestratorDisabled) {
      // Legacy statistical stagnation path — only active when the orchestrator
      // skill is disabled. The orchestrator subsumes this dynamically.
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
            log.err('auto-refine enabled but autopilot source not found (not a git checkout of agent-autopilot); exit 3');
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
            triggerReportPath: reportPath,
            refinementsSoFar: state.refinementsSoFar,
            maxRefinements: opts.maxRefinements,
            selector: refineSelector,
            events,
            runtime: opts.runtime,
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

async function writeOrchestratorEvolveReport(
  repo: string,
  iteration: number,
  reason: string,
  verdict: Verdict,
): Promise<string> {
  const dir = join(repo, '.autopilot');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'STAGNATION_REPORT.md');
  const body = [
    '# ORCHESTRATOR EVOLVE REPORT',
    '',
    `The orchestrator skill decided agent-autopilot itself should be evolved`,
    `at iteration ${iteration}. This is the trigger report for the meta-refinement`,
    `agent.`,
    '',
    `- Repo: \`${repo}\``,
    `- Detected: ${new Date().toISOString()}`,
    '',
    '## Orchestrator reason',
    '',
    reason,
    '',
    '## Latest judge verdict',
    '',
    '```json',
    JSON.stringify(verdict, null, 2),
    '```',
    '',
    '## What to look at',
    '',
    '1. Read this report.',
    '2. Read `.autopilot/iterations/<latest>/worker-transcript.md` for the most',
    '   recent worker activity.',
    '3. Read `.autopilot/events.jsonl` for the full event stream.',
    '4. Decide whether the symptom belongs in:',
    '   - `skills/<name>/SKILL.md` — prompt-level fix (most common)',
    '   - `src/<module>.ts` — code-level fix',
    '5. Make the surgical fix, run npm test + npm run build, commit, push.',
    '',
  ].join('\n');
  await writeFile(path, body, 'utf8');
  return path;
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

// re-export defaults for CLI consumption
export { DEFAULT_WORKER_MODELS, DEFAULT_JUDGE_MODELS };
