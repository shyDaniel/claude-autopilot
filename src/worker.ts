import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { workerPrompt } from './prompts.js';
import { log } from './logging.js';

export interface WorkerArgs {
  repoPath: string;
  iteration: number;
  outstandingSummary: string;
  outstandingBullets: string[];
  noPush: boolean;
  model?: string;
  maxTurns?: number;
}

export interface WorkerResult {
  completedTurns: number;
  usage?: unknown;
  finalText: string;
}

export async function runWorker(args: WorkerArgs): Promise<WorkerResult> {
  const prompt = workerPrompt({
    repoPath: args.repoPath,
    iteration: args.iteration,
    outstandingSummary: args.outstandingSummary,
    outstandingBullets: args.outstandingBullets,
    noPush: args.noPush,
  });

  const options: Options = {
    cwd: args.repoPath,
    permissionMode: 'bypassPermissions',
    // All tools allowed by default (undefined allowedTools = all).
    // MCP servers are inherited from the user's global/project settings.
    ...(args.model ? { model: args.model } : {}),
    ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        'You are running under claude-autopilot in a zero-human-in-the-loop loop. ' +
        'Never ask clarifying questions. Spawn subagents or search the web instead. ' +
        'Burn tokens. Ship production-grade work.',
    },
  };

  let turns = 0;
  let finalText = '';
  let usage: unknown;

  try {
    for await (const msg of query({ prompt, options })) {
      turns += summarizeMessage(msg, args.iteration);
      if (msg.type === 'result') {
        usage = (msg as unknown as { usage?: unknown }).usage;
        finalText =
          (msg as unknown as { result?: string }).result ??
          finalText;
      }
    }
  } catch (err) {
    log.err(`worker error: ${(err as Error).message}`);
    throw err;
  }

  return { completedTurns: turns, usage, finalText };
}

function summarizeMessage(msg: SDKMessage, iter: number): number {
  switch (msg.type) {
    case 'assistant': {
      const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
        if (block.type === 'text' && block.text) {
          const firstLine = block.text.split('\n').find((l) => l.trim()) ?? '';
          if (firstLine) log.dim(`  [iter ${iter}] ${truncate(firstLine, 180)}`);
        } else if (block.type === 'tool_use') {
          log.step(`  [iter ${iter}] tool: ${block.name}`);
        }
      }
      return 1;
    }
    case 'user':
      return 0;
    case 'result': {
      const r = msg as unknown as { subtype?: string; num_turns?: number };
      log.dim(`  [iter ${iter}] result: ${r.subtype ?? 'ok'} (turns=${r.num_turns ?? '?'})`);
      return 0;
    }
    case 'system':
      return 0;
    default:
      return 0;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
