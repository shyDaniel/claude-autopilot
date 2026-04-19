import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { metaRefinePrompt } from '../prompts.js';
import { log } from '../logging.js';
import type { EventLog } from '../events.js';
import { withModel, type ModelSelector } from '../model.js';

export interface RefineArgs {
  autopilotSource: string;
  targetRepo: string;
  stagnationReportPath: string;
  refinementsSoFar: number;
  maxRefinements: number;
  selector: ModelSelector;
  events: EventLog;
}

export interface RefineResult {
  success: boolean;
  reason?: string;
  preHeadSha?: string;
  postHeadSha?: string;
  transcriptPath?: string;
}

/**
 * Try to auto-locate the autopilot source repo from `import.meta.url`. Works
 * whether autopilot is running from `dist/` (installed / npm-linked) or
 * `src/` (dev). Returns the path if it looks like a writable git checkout of
 * claude-autopilot, otherwise null.
 */
export function detectAutopilotSource(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    // Walk up until we find a directory with package.json.
    let dir = dirname(here);
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'claude-autopilot') {
          if (existsSync(join(dir, '.git'))) return dir;
          return null; // installed read-only from registry — can't self-modify
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function runMetaRefinement(args: RefineArgs): Promise<RefineResult> {
  const autopilotSource = resolve(args.autopilotSource);
  if (!existsSync(join(autopilotSource, '.git'))) {
    return { success: false, reason: `autopilot source at ${autopilotSource} is not a git repo; cannot self-modify` };
  }

  // Checkpoint: record HEAD sha for reporting & optional rollback.
  const preHeadSha = git(autopilotSource, ['rev-parse', 'HEAD']);
  log.banner('META-REFINEMENT');
  log.info(`autopilot source: ${autopilotSource}`);
  log.info(`target repo:      ${args.targetRepo}`);
  log.info(`stagnation report: ${args.stagnationReportPath}`);
  log.info(`refinement #${args.refinementsSoFar + 1} / ${args.maxRefinements}`);

  await args.events.emit({
    iter: 0,
    phase: 'loop',
    kind: 'start',
    msg: `refinement#${args.refinementsSoFar + 1}`,
    data: { autopilotSource, preHeadSha },
  });

  const prompt = metaRefinePrompt({
    autopilotRepo: autopilotSource,
    targetRepo: args.targetRepo,
    stagnationReportPath: args.stagnationReportPath,
    recentIterationsPath: join(args.targetRepo, '.autopilot', 'iterations'),
    eventsPath: join(args.targetRepo, '.autopilot', 'events.jsonl'),
    refinementsSoFar: args.refinementsSoFar,
    maxRefinements: args.maxRefinements,
  });

  const transcript: string[] = [];
  try {
    await withModel(args.selector, async (model) => {
      const options: Options = {
        cwd: autopilotSource,
        permissionMode: 'bypassPermissions',
        model,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'You are the META-REFINEMENT agent for claude-autopilot itself. ' +
            'You are editing the tool, not the downstream project. Never ' +
            'modify the target repo. Commit + push only after tests and build ' +
            'pass.',
        },
      };
      for await (const msg of query({ prompt, options })) {
        collectMeta(msg, transcript);
      }
    });
  } catch (err) {
    await args.events.emit({
      iter: 0,
      phase: 'loop',
      kind: 'error',
      msg: `refinement agent failed: ${(err as Error).message}`,
    });
    return { success: false, reason: (err as Error).message, preHeadSha };
  }

  const transcriptPath = await saveTranscript(args.targetRepo, args.refinementsSoFar + 1, transcript.join('\n'));

  // Verify: tests + build must pass. Don't relaunch on a broken autopilot.
  log.step('verifying refined autopilot: npm install && npm test && npm run build');
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: autopilotSource,
      stdio: 'inherit',
    });
    execFileSync('npm', ['test', '--silent'], { cwd: autopilotSource, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build', '--silent'], { cwd: autopilotSource, stdio: 'inherit' });
  } catch (err) {
    const reason = `verification failed after refinement: ${(err as Error).message}`;
    log.err(reason);
    await args.events.emit({ iter: 0, phase: 'loop', kind: 'error', msg: reason });
    return { success: false, reason, preHeadSha, transcriptPath };
  }

  const postHeadSha = git(autopilotSource, ['rev-parse', 'HEAD']);
  const changed = postHeadSha && postHeadSha !== preHeadSha;
  if (!changed) {
    const reason = 'refinement agent made no commits; nothing to relaunch with';
    log.warn(reason);
    await args.events.emit({ iter: 0, phase: 'loop', kind: 'error', msg: reason });
    return { success: false, reason, preHeadSha, postHeadSha, transcriptPath };
  }

  await args.events.emit({
    iter: 0,
    phase: 'loop',
    kind: 'commit',
    msg: `refinement#${args.refinementsSoFar + 1}: ${preHeadSha?.slice(0, 7)} → ${postHeadSha?.slice(0, 7)}`,
    data: { preHeadSha, postHeadSha, transcriptPath },
  });

  return { success: true, preHeadSha, postHeadSha, transcriptPath };
}

function collectMeta(msg: SDKMessage, out: string[]): void {
  if (msg.type === 'assistant') {
    const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
    for (const block of content as Array<{ type: string; text?: string; name?: string }>) {
      if (block.type === 'text' && block.text) {
        out.push(block.text);
        const firstLine = block.text.split('\n').find((l) => l.trim()) ?? '';
        if (firstLine) log.dim(`  [refine] ${truncate(firstLine, 180)}`);
      } else if (block.type === 'tool_use') {
        const name = block.name ?? 'tool';
        log.step(`  [refine] tool: ${name}`);
        out.push(`\n[tool: ${name}]`);
      }
    }
  } else if (msg.type === 'result') {
    const r = (msg as unknown as { result?: string }).result;
    if (r) out.push(r);
  }
}

async function saveTranscript(targetRepo: string, refinementN: number, text: string): Promise<string> {
  const dir = join(targetRepo, '.autopilot', 'refinements', String(refinementN).padStart(3, '0'));
  await mkdir(dir, { recursive: true });
  const p = join(dir, 'transcript.md');
  await writeFile(p, text || '(empty transcript)', 'utf8');
  return p;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Re-exec the autopilot binary with the original argv, ensuring --resume is
 * present. The child inherits stdio so the user sees continuous output.
 */
export async function relaunchAutopilot(): Promise<number> {
  const node = process.argv[0];
  const script = process.argv[1];
  const userArgs = process.argv.slice(2);

  // Strip any pre-existing --resume / --no-resume to avoid duplicates.
  const filtered = userArgs.filter((a) => a !== '--resume' && a !== '--no-resume');
  // Insert --resume after the subcommand (index 0 if present) or at front.
  const hasSubcommand = filtered[0] === 'run' || filtered[0] === 'status' || filtered[0] === 'watch' || filtered[0] === 'log';
  const next = hasSubcommand ? [filtered[0], '--resume', ...filtered.slice(1)] : ['--resume', ...filtered];

  log.banner('RELAUNCH');
  log.info(`${node} ${script} ${next.join(' ')}`);

  const child = spawn(node, [script, ...next], {
    stdio: 'inherit',
    detached: false,
  });

  return await new Promise<number>((resolveP) => {
    child.on('exit', (code, signal) => {
      if (signal) {
        resolveP(128 + (signalNumber(signal) ?? 0));
      } else {
        resolveP(code ?? 0);
      }
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  const map: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 };
  return map[signal];
}

export async function writeRefinementFailureNote(targetRepo: string, reason: string): Promise<void> {
  const path = join(targetRepo, '.autopilot', 'STAGNATION_REPORT.md');
  try {
    const existing = await readFile(path, 'utf8');
    const tail = `\n\n---\n\n## Refinement attempt failed\n\n- When: ${new Date().toISOString()}\n- Reason: ${reason}\n`;
    await writeFile(path, existing + tail, 'utf8');
  } catch {
    // best-effort
  }
}
