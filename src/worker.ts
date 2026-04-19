import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { workerPrompt } from './prompts.js';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';

export interface WorkerArgs {
  repoPath: string;
  iteration: number;
  outstandingSummary: string;
  outstandingBullets: string[];
  noPush: boolean;
  model?: string;
  maxTurns?: number;
  events: EventLog;
  status: StatusWriter;
}

export interface WorkerResult {
  completedTurns: number;
  usage?: unknown;
  finalText: string;
  transcript: string;
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

  await args.events.emit({ iter: args.iteration, phase: 'worker', kind: 'start' });

  let turns = 0;
  let finalText = '';
  let usage: unknown;
  const transcript: string[] = [];

  try {
    for await (const msg of query({ prompt, options })) {
      turns += await handleMessage(msg, args, transcript);
      if (msg.type === 'result') {
        usage = (msg as unknown as { usage?: unknown }).usage;
        finalText = (msg as unknown as { result?: string }).result ?? finalText;
      }
    }
  } catch (err) {
    await args.events.emit({
      iter: args.iteration,
      phase: 'worker',
      kind: 'error',
      msg: (err as Error).message,
    });
    log.err(`worker error: ${(err as Error).message}`);
    throw err;
  }

  await args.events.emit({
    iter: args.iteration,
    phase: 'worker',
    kind: 'end',
    msg: `turns=${turns}`,
    data: { usage },
  });

  return { completedTurns: turns, usage, finalText, transcript: transcript.join('\n') };
}

async function handleMessage(msg: SDKMessage, args: WorkerArgs, transcript: string[]): Promise<number> {
  switch (msg.type) {
    case 'assistant': {
      const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
        if (block.type === 'text' && block.text) {
          const firstLine = block.text.split('\n').find((l) => l.trim()) ?? '';
          if (firstLine) {
            log.dim(`  [iter ${args.iteration}] ${truncate(firstLine, 180)}`);
            await args.events.emit({
              iter: args.iteration,
              phase: 'worker',
              kind: 'text',
              msg: truncate(firstLine, 240),
            });
            await args.status.update({ currentAction: `thinking: ${truncate(firstLine, 80)}` });
          }
          transcript.push(block.text);
        } else if (block.type === 'tool_use') {
          const name = block.name ?? 'tool';
          const preview = previewInput(block.input);
          log.step(`  [iter ${args.iteration}] tool: ${name} ${preview}`);
          await args.events.emit({
            iter: args.iteration,
            phase: 'worker',
            kind: 'tool',
            msg: name,
            data: { input: sanitize(block.input) },
          });
          await args.status.update({ currentAction: `running tool: ${name}` });
          transcript.push(`\n[tool: ${name}] ${preview}`);
        }
      }
      return 1;
    }
    case 'result': {
      const r = msg as unknown as { subtype?: string; num_turns?: number };
      log.dim(`  [iter ${args.iteration}] result: ${r.subtype ?? 'ok'} (turns=${r.num_turns ?? '?'})`);
      return 0;
    }
    default:
      return 0;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function previewInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const candidates = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === 'string') return `(${k}=${truncate(v, 100)})`;
  }
  return '';
}

function sanitize(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v.length > 400 ? v.slice(0, 400) + '…' : v;
    else out[k] = v;
  }
  return out;
}
