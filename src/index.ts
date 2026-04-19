#!/usr/bin/env node
import { Command } from 'commander';
import { runAutopilot } from './autopilot.js';
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
      'observability and stagnation detection.',
  )
  .version('0.2.0');

program
  .command('run', { isDefault: true })
  .description('start the autopilot loop against a repo')
  .argument('[repo]', 'path to the target repository', '.')
  .option('--max-iterations <n>', 'cap total iterations (default: unlimited)', (v) => parseInt(v, 10))
  .option('--worker-model <id>', 'model id for the worker session')
  .option('--judge-model <id>', 'model id for the judge session')
  .option('--worker-max-turns <n>', 'cap turns per worker iteration', (v) => parseInt(v, 10))
  .option('--judge-max-turns <n>', 'cap turns per judge iteration', (v) => parseInt(v, 10))
  .option('--stagnation-threshold <n>', 'iterations with no progress before halting', (v) => parseInt(v, 10), 3)
  .option('--no-stagnation', 'disable the stagnation detector')
  .option('--no-push', 'commit but do not push')
  .option('--dry-run', 'run the judge once and exit, without invoking the worker')
  .option('--resume', 'resume from .autopilot/state.json inside the target repo')
  .action(async (repo: string, opts: Record<string, unknown>) => {
    try {
      const code = await runAutopilot({
        repo,
        maxIterations: opts.maxIterations as number | undefined,
        workerModel: opts.workerModel as string | undefined,
        judgeModel: opts.judgeModel as string | undefined,
        workerMaxTurns: opts.workerMaxTurns as number | undefined,
        judgeMaxTurns: opts.judgeMaxTurns as number | undefined,
        stagnationThreshold: (opts.stagnationThreshold as number | undefined) ?? 3,
        stagnationDisabled: (opts as { stagnation?: boolean }).stagnation === false,
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
