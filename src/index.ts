#!/usr/bin/env node
import { Command } from 'commander';
import { runAutopilot } from './autopilot.js';
import { log } from './logging.js';

const program = new Command();

program
  .name('autopilot')
  .description(
    'Infinite-loop wrapper around Claude Code. Drives a repo from its ' +
      'current state to "done-done" per FINAL_GOAL.md — zero human in the loop.',
  )
  .argument('[repo]', 'path to the target repository', '.')
  .option('--max-iterations <n>', 'cap total iterations (default: unlimited)', (v) => parseInt(v, 10))
  .option('--worker-model <id>', 'model id for the worker session')
  .option('--judge-model <id>', 'model id for the judge session')
  .option('--worker-max-turns <n>', 'cap turns per worker iteration', (v) => parseInt(v, 10))
  .option('--judge-max-turns <n>', 'cap turns per judge iteration', (v) => parseInt(v, 10))
  .option('--no-push', 'commit but do not push')
  .option('--dry-run', 'run the judge once and exit, without invoking the worker')
  .option('--resume', 'resume from .autopilot/state.json inside the target repo')
  .action(async (repo: string, opts: Record<string, unknown>) => {
    try {
      await runAutopilot({
        repo,
        maxIterations: opts.maxIterations as number | undefined,
        workerModel: opts.workerModel as string | undefined,
        judgeModel: opts.judgeModel as string | undefined,
        workerMaxTurns: opts.workerMaxTurns as number | undefined,
        judgeMaxTurns: opts.judgeMaxTurns as number | undefined,
        // commander sets .push=false when --no-push is passed
        noPush: (opts as { push?: boolean }).push === false,
        dryRun: Boolean(opts.dryRun),
        resume: Boolean(opts.resume),
      });
    } catch (err) {
      log.err((err as Error).stack ?? (err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  log.err((err as Error).message);
  process.exit(1);
});
