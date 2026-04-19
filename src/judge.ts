import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { judgePrompt } from './prompts.js';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';
import { withModel, type ModelSelector } from './model.js';

export interface Verdict {
  done: boolean;
  summary: string;
  outstanding: string[];
}

export interface JudgeArgs {
  repoPath: string;
  iteration: number;
  selector: ModelSelector;
  maxTurns?: number;
  events: EventLog;
  status: StatusWriter;
}

export async function runJudge(args: JudgeArgs): Promise<Verdict> {
  const prompt = judgePrompt(args.repoPath);

  await args.events.emit({ iter: args.iteration, phase: 'judge', kind: 'start' });

  const transcript: string[] = [];
  try {
    await withModel(args.selector, async (model) => {
      const options: Options = {
        cwd: args.repoPath,
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        model,
        ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'You are the JUDGE in a claude-autopilot loop. Be uncompromising. ' +
            'Output a single fenced JSON block at the end — nothing else after it.',
        },
      };
      for await (const msg of query({ prompt, options })) {
        await handleMessage(msg, args, transcript);
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

async function handleMessage(msg: SDKMessage, args: JudgeArgs, transcript: string[]): Promise<void> {
  if (msg.type === 'assistant') {
    const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
    for (const block of content as Array<{ type: string; text?: string; name?: string }>) {
      if (block.type === 'text' && block.text) {
        transcript.push(block.text);
        const firstLine = block.text.split('\n').find((l) => l.trim()) ?? '';
        if (firstLine) {
          await args.events.emit({
            iter: args.iteration,
            phase: 'judge',
            kind: 'text',
            msg: firstLine.length > 240 ? firstLine.slice(0, 239) + '…' : firstLine,
          });
          await args.status.update({
            currentAction: `judge thinking: ${firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine}`,
          });
        }
      } else if (block.type === 'tool_use') {
        const name = block.name ?? 'tool';
        await args.events.emit({ iter: args.iteration, phase: 'judge', kind: 'tool', msg: name });
        await args.status.update({ currentAction: `judge tool: ${name}` });
      }
    }
  } else if (msg.type === 'result') {
    const r = (msg as unknown as { result?: string }).result;
    if (r) transcript.push(r);
  }
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
        return {
          done: obj.done,
          summary: obj.summary,
          outstanding: Array.isArray(obj.outstanding) ? obj.outstanding.map(String) : [],
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
