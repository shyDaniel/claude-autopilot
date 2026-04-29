import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { workerPrompt } from './prompts.js';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';
import { agentDisplayName, withModel, type AgentRuntime, type ModelSelector } from './model.js';
import { printMessage } from './transcript.js';
import type { McpServerConfig } from './mcp.js';
import { runCodexExec } from './codex.js';

export interface WorkerArgs {
  repoPath: string;
  iteration: number;
  outstandingSummary: string;
  outstandingBullets: string[];
  noPush: boolean;
  selector: ModelSelector;
  maxTurns?: number;
  events: EventLog;
  status: StatusWriter;
  verbose: boolean;
  availableMcps: string;
  isWebApp: boolean;
  subtaskBrief?: string;
  mcpServers: Record<string, McpServerConfig>;
  runtime: AgentRuntime;
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
    availableMcps: args.availableMcps,
    isWebApp: args.isWebApp,
    subtaskBrief: args.subtaskBrief,
    agentName: agentDisplayName(args.runtime),
  });

  await args.events.emit({ iter: args.iteration, phase: 'worker', kind: 'start' });

  let turns = 0;
  let finalText = '';
  let usage: unknown;
  const transcript: string[] = [];

  try {
    await withModel(args.selector, async (model) => {
      if (args.runtime === 'codex') {
        const result = await runCodexExec({
          repoPath: args.repoPath,
          label: 'worker',
          iteration: args.iteration,
          model,
          prompt,
          mode: 'worker',
          verbose: args.verbose,
          events: args.events,
          status: args.status,
          mcpServers: args.mcpServers,
        });
        turns += result.completedTurns;
        finalText = result.finalText;
        transcript.push(result.transcript);
        return;
      }

      const options: Options = {
        cwd: args.repoPath,
        permissionMode: 'bypassPermissions',
        model,
        mcpServers: args.mcpServers,
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
      for await (const msg of query({ prompt, options })) {
        turns += await printMessage(msg, {
          label: 'worker',
          iteration: args.iteration,
          verbose: args.verbose,
          events: args.events,
          status: args.status,
          transcript,
        });
        if (msg.type === 'result') {
          usage = (msg as unknown as { usage?: unknown }).usage;
          finalText = (msg as unknown as { result?: string }).result ?? finalText;
        }
      }
    });
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
    msg: `turns=${turns} model=${args.selector.current()}`,
    data: { usage, model: args.selector.current(), downgraded: args.selector.isDowngraded() },
  });

  return { completedTurns: turns, usage, finalText, transcript: transcript.join('\n') };
}
