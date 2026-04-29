import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratePrompt } from './prompts.js';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';
import { withModel, type AgentRuntime, type ModelSelector } from './model.js';
import { printMessage } from './transcript.js';
import type { McpServerConfig } from './mcp.js';
import { runCodexExec } from './codex.js';
import type { Verdict } from './judge.js';
import type { IterationSnapshot } from './metrics.js';
import type { Plan } from './planner.js';
import { planSummary } from './planner.js';

export type NextSkill = 'work' | 'reframe' | 'evolve' | 'exit-stuck';

export interface OrchestratorVerdict {
  next_skill: NextSkill;
  reason: string;
  evolve_target?: string | null;
  reframe_target_subtask_id?: string | null;
}

export interface OrchestrateArgs {
  repoPath: string;
  iteration: number;
  runStartedAt: string;
  selector: ModelSelector;
  events: EventLog;
  status: StatusWriter;
  verbose: boolean;
  judgeVerdict: Verdict;
  history: IterationSnapshot[];
  plan: Plan | null;
  refinementsSoFar: number;
  maxRefinements: number;
  mcpServers: Record<string, McpServerConfig>;
  runtime: AgentRuntime;
}

/**
 * Run the orchestrator skill — decides which skill autopilot should run next.
 * Replaces the legacy statistical stagnation detector. Always uses the strong
 * model (no fallback) per design — orchestration is too important to downgrade.
 */
export async function runOrchestrator(args: OrchestrateArgs): Promise<OrchestratorVerdict> {
  const recentHistory = args.history.slice(-5).reverse();
  const recentHistoryBlock = recentHistory.length
    ? recentHistory
        .map(
          (h) =>
            `- iter ${h.iter} (HEAD ${h.headSha?.slice(0, 7) ?? 'n/a'}, total commits ${h.commitCountTotal}): ${
              h.outstandingSummary?.slice(0, 200) ?? '(no summary)'
            }${(h.outstandingSummary?.length ?? 0) > 200 ? '…' : ''}`,
        )
        .join('\n  ')
    : '(no prior iterations)';

  const summary = args.plan ? planSummary(args.plan) : null;
  const planSummaryBlock = summary
    ? `pending=${summary.pending} in_progress=${summary.in_progress} completed=${summary.completed} ` +
      `needs_reframe=${summary.needs_reframe} reframed=${summary.reframed} blocked=${summary.blocked} ` +
      `failed=${summary.failed} (of ${summary.total})`
    : '(no plan ledger yet)';

  const recentCommitsBlock = recentCommits(args.repoPath, 10);
  const recentWorkerExcerptsBlock = await recentWorkerExcerpts(args.repoPath, args.iteration);
  const judgeVerdictBlock = JSON.stringify(args.judgeVerdict, null, 2);

  const prompt = orchestratePrompt({
    repoPath: args.repoPath,
    runStartedAt: args.runStartedAt,
    iteration: args.iteration,
    judgeVerdictBlock,
    recentHistoryBlock,
    planSummaryBlock,
    recentCommitsBlock,
    recentWorkerExcerptsBlock,
    refinementsSoFar: args.refinementsSoFar,
    maxRefinements: args.maxRefinements,
  });

  await args.events.emit({ iter: args.iteration, phase: 'orchestrate', kind: 'start' });

  const transcript: string[] = [];
  try {
    await withModel(args.selector, async (model) => {
      if (args.runtime === 'codex') {
        const result = await runCodexExec({
          repoPath: args.repoPath,
          label: 'judge', // codex.ts label is internal; use 'judge' for read-mostly
          iteration: args.iteration,
          model,
          prompt,
          mode: 'judge',
          verbose: args.verbose,
          events: args.events,
          status: args.status,
          mcpServers: args.mcpServers,
        });
        transcript.push(result.transcript);
        return;
      }

      const options: Options = {
        cwd: args.repoPath,
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        model,
        mcpServers: args.mcpServers,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'You are the ORCHESTRATOR in an agent-autopilot loop. ' +
            'Output a single fenced JSON block at the end — nothing else after it.',
        },
      };
      for await (const msg of query({ prompt, options })) {
        await printMessage(msg, {
          label: 'orchestrate',
          iteration: args.iteration,
          verbose: args.verbose,
          events: args.events,
          status: args.status,
          transcript,
        });
      }
    });
  } catch (err) {
    await args.events.emit({
      iter: args.iteration,
      phase: 'orchestrate',
      kind: 'error',
      msg: (err as Error).message,
    });
    // Fail safe: if orchestrator crashes, default to 'work' so we don't halt.
    return { next_skill: 'work', reason: `orchestrator crashed (${(err as Error).message}); defaulting to work` };
  }

  const joined = transcript.join('\n');
  const verdict = extractOrchestratorVerdict(joined) ?? {
    next_skill: 'work' as NextSkill,
    reason: 'Orchestrator did not return parseable JSON; defaulting to work.',
  };

  await args.events.emit({
    iter: args.iteration,
    phase: 'orchestrate',
    kind: 'verdict',
    msg: verdict.next_skill,
    data: { verdict },
  });

  log.info(`orchestrator: next_skill=${verdict.next_skill}  reason=${truncate(verdict.reason, 200)}`);
  return verdict;
}

export function extractOrchestratorVerdict(text: string): OrchestratorVerdict | null {
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(text)) !== null) last = match[1].trim();

  const candidates: string[] = [];
  if (last) candidates.push(last);
  const braceMatches = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  if (braceMatches.length) candidates.push(braceMatches[braceMatches.length - 1]);

  const allowed: NextSkill[] = ['work', 'reframe', 'evolve', 'exit-stuck'];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<OrchestratorVerdict>;
      if (
        typeof obj.next_skill === 'string' &&
        (allowed as string[]).includes(obj.next_skill) &&
        typeof obj.reason === 'string'
      ) {
        return {
          next_skill: obj.next_skill as NextSkill,
          reason: obj.reason,
          evolve_target: typeof obj.evolve_target === 'string' ? obj.evolve_target : null,
          reframe_target_subtask_id:
            typeof obj.reframe_target_subtask_id === 'string' ? obj.reframe_target_subtask_id : null,
        };
      }
    } catch {
      // try next
    }
  }
  return null;
}

function recentCommits(repoPath: string, n: number): string {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'log', `-${n}`, '--oneline', '--no-decorate'], {
      encoding: 'utf8',
    }).trim();
    return out || '(no commits)';
  } catch {
    return '(git log failed)';
  }
}

async function recentWorkerExcerpts(repoPath: string, currentIter: number): Promise<string> {
  const excerpts: string[] = [];
  for (const iter of [currentIter - 1, currentIter - 2]) {
    if (iter < 1) continue;
    const path = join(
      repoPath,
      '.autopilot',
      'iterations',
      String(iter).padStart(6, '0'),
      'worker-transcript.md',
    );
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, 'utf8');
      const trimmed = raw.length > 4000 ? '…' + raw.slice(-4000) : raw;
      excerpts.push(`--- iter ${iter} (last 4KB of worker transcript) ---\n${trimmed}`);
    } catch {
      // ignore
    }
  }
  return excerpts.length ? excerpts.join('\n\n') : '(no prior worker transcripts)';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
