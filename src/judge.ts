import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { judgePrompt } from './prompts.js';
import { log } from './logging.js';

export interface Verdict {
  done: boolean;
  summary: string;
  outstanding: string[];
}

export interface JudgeArgs {
  repoPath: string;
  model?: string;
  maxTurns?: number;
}

export async function runJudge(args: JudgeArgs): Promise<Verdict> {
  const prompt = judgePrompt(args.repoPath);
  const options: Options = {
    cwd: args.repoPath,
    permissionMode: 'bypassPermissions',
    // Judge reads and runs tests but should not modify files. We still allow
    // Bash (to run tests) and Read/Grep/Glob. Disallow write-oriented tools to
    // keep the judge honest.
    disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    ...(args.model ? { model: args.model } : {}),
    ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        'You are the JUDGE in a claude-autopilot loop. Be uncompromising. ' +
        'Output a single fenced JSON block at the end — nothing else after it.',
    },
  };

  const transcript: string[] = [];
  for await (const msg of query({ prompt, options })) {
    collectText(msg, transcript);
  }

  const joined = transcript.join('\n');
  const verdict = extractVerdict(joined);
  if (!verdict) {
    log.warn('judge returned no parseable verdict; assuming not done');
    return {
      done: false,
      summary: 'Judge did not return structured output; treating as not done.',
      outstanding: ['Re-run judge; ensure FINAL_GOAL.md is present and well-formed.'],
    };
  }
  return verdict;
}

function collectText(msg: SDKMessage, out: string[]): void {
  if (msg.type === 'assistant') {
    const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
    for (const block of content as Array<{ type: string; text?: string }>) {
      if (block.type === 'text' && block.text) out.push(block.text);
    }
  } else if (msg.type === 'result') {
    const r = (msg as unknown as { result?: string }).result;
    if (r) out.push(r);
  }
}

function extractVerdict(text: string): Verdict | null {
  // Prefer the LAST fenced json block in the transcript.
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(text)) !== null) {
    last = match[1].trim();
  }
  const candidates: string[] = [];
  if (last) candidates.push(last);
  // Fallback: last {...} object in the transcript.
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
