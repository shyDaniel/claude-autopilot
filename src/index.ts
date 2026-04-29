#!/usr/bin/env node
import { basename } from 'node:path';
import { Command } from 'commander';
import { runAutopilot } from './autopilot.js';
import { defaultJudgeModels, defaultWorkerModels, normalizeAgentRuntime } from './model.js';
import { statusCommand } from './commands/status.js';
import { watchCommand } from './commands/watch.js';
import { logCommand } from './commands/log.js';
import { log } from './logging.js';

const program = new Command();
const invokedName = basename(process.argv[1] ?? 'autopilot').includes('codex') ? 'codex-autopilot' : 'autopilot';

program
  .name(invokedName)
  .description(
    'Zero-human-in-the-loop wrapper around Claude Code or Codex. Drives a repo from ' +
      'its current state to "done-done" per FINAL_GOAL.md, with live ' +
      'observability, sticky model fallback, and self-refinement on stagnation.',
  )
  .version('0.3.0');

program
  .command('run', { isDefault: true })
  .description('start the autopilot loop against a repo')
  .argument('[repo]', 'path to the target repository', '.')
  .option('--agent <runtime>', 'coding agent runtime: claude or codex (default: claude; codex-autopilot defaults codex)')
  .option('--max-iterations <n>', 'cap total iterations (default: unlimited)', (v) => parseInt(v, 10))
  .option('--worker-model <id>', 'primary worker model (runtime-specific default)')
  .option('--worker-fallback-model <id>', 'worker model used after a rate-limit/overload on primary (runtime-specific default)')
  .option('--judge-model <id>', 'primary judge model (runtime-specific default)')
  .option('--judge-fallback-model <id>', 'judge fallback model (runtime-specific default)')
  .option('--worker-max-turns <n>', 'cap turns per worker iteration', (v) => parseInt(v, 10))
  .option('--judge-max-turns <n>', 'cap turns per judge iteration', (v) => parseInt(v, 10))
  .option('--stagnation-threshold <n>', 'iterations with no progress before halting', (v) => parseInt(v, 10), 3)
  .option('--max-subtask-attempts <n>', 'mark a subtask failed after N unsuccessful worker iterations on it', (v) => parseInt(v, 10), 3)
  .option('--no-stagnation', 'disable the stagnation detector')
  .option('--no-auto-refine', 'on stagnation, do NOT spawn a meta-agent to refine autopilot itself')
  .option('--autopilot-source <path>', 'path to the agent-autopilot source repo (auto-detected if omitted)')
  .option('--max-refinements <n>', 'cap how many times autopilot can refine itself per target run', (v) => parseInt(v, 10), 3)
  .option('--no-email', 'disable email alerts even if SMTP env vars are set')
  .option('-v, --verbose', 'stream full text blocks and full tool inputs to stdout (otherwise only first line / name preview)')
  .option('--start-cmd <cmd>', 'command to restart the target service on done (default: auto-detect from start.sh / package.json / pyproject.toml)')
  .option('--no-start-on-done', 'do not (re)start the target service when the judge returns done:true')
  .option('--no-push', 'commit but do not push')
  .option('--no-eval', 'disable the eval skill (second-pass critic that overrides judge done)')
  .option('--no-orchestrator', 'disable the orchestrator skill (falls back to legacy stagnation control)')
  .option('--dry-run', 'run the judge once and exit, without invoking the worker')
  .option('--resume', 'resume from .autopilot/state.json inside the target repo')
  .action(async (repo: string, opts: Record<string, unknown>) => {
    try {
      const defaultRuntime = process.env.AUTOPILOT_AGENT ?? (basename(process.argv[1] ?? '').includes('codex') ? 'codex' : 'claude');
      const runtime = normalizeAgentRuntime((opts.agent as string | undefined) ?? defaultRuntime);
      const workerDefaults = defaultWorkerModels(runtime);
      const judgeDefaults = defaultJudgeModels(runtime);
      const code = await runAutopilot({
        repo,
        runtime,
        maxIterations: opts.maxIterations as number | undefined,
        workerModels: {
          primary: (opts.workerModel as string) ?? workerDefaults.primary,
          fallback: (opts.workerFallbackModel as string) ?? workerDefaults.fallback,
        },
        judgeModels: {
          primary: (opts.judgeModel as string) ?? judgeDefaults.primary,
          fallback: (opts.judgeFallbackModel as string) ?? judgeDefaults.fallback,
        },
        workerMaxTurns: opts.workerMaxTurns as number | undefined,
        judgeMaxTurns: opts.judgeMaxTurns as number | undefined,
        stagnationThreshold: (opts.stagnationThreshold as number | undefined) ?? 3,
        maxSubtaskAttempts: (opts.maxSubtaskAttempts as number | undefined) ?? 3,
        stagnationDisabled: (opts as { stagnation?: boolean }).stagnation === false,
        autoRefine: (opts as { autoRefine?: boolean }).autoRefine !== false,
        autopilotSource: opts.autopilotSource as string | undefined,
        maxRefinements: (opts.maxRefinements as number | undefined) ?? 3,
        emailDisabled: (opts as { email?: boolean }).email === false,
        verbose: Boolean(opts.verbose),
        startCmd: opts.startCmd as string | undefined,
        startOnDoneDisabled: (opts as { startOnDone?: boolean }).startOnDone === false,
        noPush: (opts as { push?: boolean }).push === false,
        evalDisabled: (opts as { eval?: boolean }).eval === false,
        orchestratorDisabled: (opts as { orchestrator?: boolean }).orchestrator === false,
        dryRun: Boolean(opts.dryRun),
        resume: Boolean(opts.resume),
      });
      process.exit(code);
    } catch (err) {
      log.err((err as Error).stack ?? (err as Error).message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('print the current autopilot status for a repo')
  .argument('[repo]', 'path to the target repository', '.')
  .action(async (repo: string) => {
    process.exit(await statusCommand(repo));
  });

program
  .command('watch')
  .description('live-tail the autopilot event stream for a repo')
  .argument('[repo]', 'path to the target repository', '.')
  .option('--since <iter>', 'start from iteration N instead of tailing from the end', (v) => parseInt(v, 10))
  .action(async (repo: string, opts: { since?: number }) => {
    try {
      await watchCommand(repo, opts);
    } catch (err) {
      log.err((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('log')
  .description('print the iteration history from the event stream')
  .argument('[repo]', 'path to the target repository', '.')
  .option('--since <iter>', 'only include iterations from N onward', (v) => parseInt(v, 10))
  .option('--tail <n>', 'only show the last N iterations', (v) => parseInt(v, 10))
  .action(async (repo: string, opts: { since?: number; tail?: number }) => {
    process.exit(await logCommand(repo, opts));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  log.err((err as Error).message);
  process.exit(1);
});
