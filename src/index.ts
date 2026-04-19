#!/usr/bin/env node
import { Command } from 'commander';
import { runAutopilot } from './autopilot.js';
import { DEFAULT_JUDGE_MODELS, DEFAULT_WORKER_MODELS } from './model.js';
import { statusCommand } from './commands/status.js';
import { watchCommand } from './commands/watch.js';
import { logCommand } from './commands/log.js';
import { log } from './logging.js';

const program = new Command();

program
  .name('autopilot')
  .description(
    'Zero-human-in-the-loop wrapper around Claude Code. Drives a repo from ' +
      'its current state to "done-done" per FINAL_GOAL.md, with live ' +
      'observability, sticky model fallback, and self-refinement on stagnation.',
  )
  .version('0.3.0');

program
  .command('run', { isDefault: true })
  .description('start the autopilot loop against a repo')
  .argument('[repo]', 'path to the target repository', '.')
  .option('--max-iterations <n>', 'cap total iterations (default: unlimited)', (v) => parseInt(v, 10))
  .option('--worker-model <id>', `primary worker model (default ${DEFAULT_WORKER_MODELS.primary})`, DEFAULT_WORKER_MODELS.primary)
  .option('--worker-fallback-model <id>', `worker model used after a rate-limit/overload on primary (default ${DEFAULT_WORKER_MODELS.fallback})`, DEFAULT_WORKER_MODELS.fallback)
  .option('--judge-model <id>', `primary judge model (default ${DEFAULT_JUDGE_MODELS.primary})`, DEFAULT_JUDGE_MODELS.primary)
  .option('--judge-fallback-model <id>', `judge fallback model (default ${DEFAULT_JUDGE_MODELS.fallback})`, DEFAULT_JUDGE_MODELS.fallback)
  .option('--worker-max-turns <n>', 'cap turns per worker iteration', (v) => parseInt(v, 10))
  .option('--judge-max-turns <n>', 'cap turns per judge iteration', (v) => parseInt(v, 10))
  .option('--stagnation-threshold <n>', 'iterations with no progress before halting', (v) => parseInt(v, 10), 3)
  .option('--no-stagnation', 'disable the stagnation detector')
  .option('--no-auto-refine', 'on stagnation, do NOT spawn a meta-agent to refine autopilot itself')
  .option('--autopilot-source <path>', 'path to the claude-autopilot source repo (auto-detected if omitted)')
  .option('--max-refinements <n>', 'cap how many times autopilot can refine itself per target run', (v) => parseInt(v, 10), 3)
  .option('--no-email', 'disable email alerts even if SMTP env vars are set')
  .option('-v, --verbose', 'stream full text blocks and full tool inputs to stdout (otherwise only first line / name preview)')
  .option('--no-push', 'commit but do not push')
  .option('--dry-run', 'run the judge once and exit, without invoking the worker')
  .option('--resume', 'resume from .autopilot/state.json inside the target repo')
  .action(async (repo: string, opts: Record<string, unknown>) => {
    try {
      const code = await runAutopilot({
        repo,
        maxIterations: opts.maxIterations as number | undefined,
        workerModels: {
          primary: (opts.workerModel as string) ?? DEFAULT_WORKER_MODELS.primary,
          fallback: (opts.workerFallbackModel as string) ?? DEFAULT_WORKER_MODELS.fallback,
        },
        judgeModels: {
          primary: (opts.judgeModel as string) ?? DEFAULT_JUDGE_MODELS.primary,
          fallback: (opts.judgeFallbackModel as string) ?? DEFAULT_JUDGE_MODELS.fallback,
        },
        workerMaxTurns: opts.workerMaxTurns as number | undefined,
        judgeMaxTurns: opts.judgeMaxTurns as number | undefined,
        stagnationThreshold: (opts.stagnationThreshold as number | undefined) ?? 3,
        stagnationDisabled: (opts as { stagnation?: boolean }).stagnation === false,
        autoRefine: (opts as { autoRefine?: boolean }).autoRefine !== false,
        autopilotSource: opts.autopilotSource as string | undefined,
        maxRefinements: (opts.maxRefinements as number | undefined) ?? 3,
        emailDisabled: (opts as { email?: boolean }).email === false,
        verbose: Boolean(opts.verbose),
        noPush: (opts as { push?: boolean }).push === false,
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
