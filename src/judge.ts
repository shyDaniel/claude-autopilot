import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { judgePrompt } from './prompts.js';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';
import { agentDisplayName, withModel, type AgentRuntime, type ModelSelector } from './model.js';
import { printMessage } from './transcript.js';
import type { McpServerConfig } from './mcp.js';
import { runCodexExec } from './codex.js';

export interface StructuredSubtask {
  title?: string;
  files?: string[];
  symptom?: string;
  desired?: string;
  acceptance?: string;
  reframedFrom?: string;
  blocked?: boolean;
  blockedReason?: string;
}

export interface Verdict {
  done: boolean;
  summary: string;
  outstanding: string[];
  subtasks?: StructuredSubtask[];
}

export interface JudgeArgs {
  repoPath: string;
  iteration: number;
  selector: ModelSelector;
  maxTurns?: number;
  events: EventLog;
  status: StatusWriter;
  verbose: boolean;
  availableMcps: string;
  isWebApp: boolean;
  stuckBrief?: string;
  mcpServers: Record<string, McpServerConfig>;
  runtime: AgentRuntime;
}

export async function runJudge(args: JudgeArgs): Promise<Verdict> {
  const prompt = judgePrompt({
    repoPath: args.repoPath,
    availableMcps: args.availableMcps,
    isWebApp: args.isWebApp,
    stuckBrief: args.stuckBrief,
    agentName: agentDisplayName(args.runtime),
  });

  await args.events.emit({ iter: args.iteration, phase: 'judge', kind: 'start' });

  const transcript: string[] = [];
  try {
    await withModel(args.selector, async (model) => {
      if (args.runtime === 'codex') {
        const result = await runCodexExec({
          repoPath: args.repoPath,
          label: 'judge',
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
        ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'You are the JUDGE in an agent-autopilot loop. Be uncompromising. ' +
            'Output a single fenced JSON block at the end — nothing else after it.',
        },
      };
      for await (const msg of query({ prompt, options })) {
        await printMessage(msg, {
          label: 'judge',
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
      phase: 'judge',
      kind: 'error',
      msg: (err as Error).message,
    });
    throw err;
  }

  const joined = transcript.join('\n');
  const verdict = extractVerdict(joined) ?? {
    done: false,
    summary: 'Judge did not return structured output; treating as not done.',
    outstanding: ['Re-run judge; ensure FINAL_GOAL.md is present and well-formed.'],
  };

  await args.events.emit({
    iter: args.iteration,
    phase: 'judge',
    kind: 'verdict',
    msg: verdict.done ? 'DONE' : `${verdict.outstanding.length} outstanding`,
    data: { verdict },
  });

  if (!extractVerdict(joined)) log.warn('judge returned no parseable verdict; assuming not done');
  return verdict;
}

export function extractVerdict(text: string): Verdict | null {
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
      const obj = JSON.parse(c) as Partial<Verdict>;
      if (typeof obj.done === 'boolean' && typeof obj.summary === 'string') {
        const subtasks = Array.isArray(obj.subtasks)
          ? obj.subtasks.filter((s): s is StructuredSubtask => !!s && typeof s === 'object')
          : undefined;
        return {
          done: obj.done,
          summary: obj.summary,
          outstanding: Array.isArray(obj.outstanding) ? obj.outstanding.map(String) : [],
          subtasks,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
