import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { evalPrompt } from './prompts.js';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';
import { agentDisplayName, withModel, type AgentRuntime, type ModelSelector } from './model.js';
import { printMessage } from './transcript.js';
import type { McpServerConfig } from './mcp.js';
import { runCodexExec } from './codex.js';
import type { Verdict, StructuredSubtask } from './judge.js';

export interface EvalVerdict {
  passed: boolean;
  summary: string;
  blockers: string[];
  subtasks?: StructuredSubtask[];
}

export interface EvalArgs {
  repoPath: string;
  iteration: number;
  selector: ModelSelector;
  maxTurns?: number;
  events: EventLog;
  status: StatusWriter;
  verbose: boolean;
  availableMcps: string;
  judgeVerdict: Verdict;
  mcpServers: Record<string, McpServerConfig>;
  runtime: AgentRuntime;
}

/**
 * Run the eval skill — an adversarial second-pass critic that may
 * overrule the judge's "done: true" verdict. Eval can override done
 * indefinitely (no cap); the only way to ship is for eval to ALSO say
 * passed: true.
 */
export async function runEval(args: EvalArgs): Promise<EvalVerdict> {
  const judgeVerdictBlock = JSON.stringify(args.judgeVerdict, null, 2);
  const prompt = evalPrompt({
    repoPath: args.repoPath,
    availableMcps: args.availableMcps,
    judgeVerdictBlock,
    agentName: agentDisplayName(args.runtime),
  });

  await args.events.emit({ iter: args.iteration, phase: 'eval', kind: 'start' });

  const transcript: string[] = [];
  try {
    await withModel(args.selector, async (model) => {
      if (args.runtime === 'codex') {
        const result = await runCodexExec({
          repoPath: args.repoPath,
          label: 'eval',
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
        // Eval should NOT modify the repo — it only takes screenshots
        // and reads. Disallow write tools, same as the judge.
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        model,
        mcpServers: args.mcpServers,
        ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'You are the EVAL in an agent-autopilot loop — a critic that may overrule the judge. ' +
            'Be skeptical. Output a single fenced JSON block at the end — nothing else after it.',
        },
      };
      for await (const msg of query({ prompt, options })) {
        await printMessage(msg, {
          label: 'eval',
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
      phase: 'eval',
      kind: 'error',
      msg: (err as Error).message,
    });
    throw err;
  }

  const joined = transcript.join('\n');
  const verdict = extractEvalVerdict(joined) ?? {
    passed: false,
    summary: 'Eval did not return structured output; treating as not passed (refusing to ship).',
    blockers: ['Re-run eval; ensure it produces a fenced JSON block.'],
  };

  await args.events.emit({
    iter: args.iteration,
    phase: 'eval',
    kind: 'verdict',
    msg: verdict.passed ? 'PASSED' : `${verdict.blockers.length} blocker(s)`,
    data: { verdict },
  });

  if (!extractEvalVerdict(joined)) log.warn('eval returned no parseable verdict; treating as not passed');
  return verdict;
}

export function extractEvalVerdict(text: string): EvalVerdict | null {
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(text)) !== null) last = match[1].trim();

  const candidates: string[] = [];
  if (last) candidates.push(last);
  const braceMatches = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  if (braceMatches.length) candidates.push(braceMatches[braceMatches.length - 1]);

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<EvalVerdict>;
      if (typeof obj.passed === 'boolean' && typeof obj.summary === 'string') {
        const subtasks = Array.isArray(obj.subtasks)
          ? obj.subtasks.filter((s): s is StructuredSubtask => !!s && typeof s === 'object')
          : undefined;
        return {
          passed: obj.passed,
          summary: obj.summary,
          blockers: Array.isArray(obj.blockers) ? obj.blockers.map(String) : [],
          subtasks,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
