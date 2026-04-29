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
 *
 * Resilience: the SDK process can crash mid-stream with a non-zero
 * exit code (e.g. `Claude Code process exited with code 1`) AFTER the
 * eval has already finished its visible reasoning but BEFORE it gets
 * to print the final fenced JSON. Two-stage handling:
 *   1. Even on crash, parse the transcript collected so far — if a
 *      valid fenced JSON verdict was emitted before the crash, honour
 *      it (the crash is post-hoc, the decision was made).
 *   2. Otherwise, retry the eval ONCE with a fresh attempt. Only if
 *      both attempts produce no parseable verdict do we fall back to
 *      "not passed" (refusing to ship is the safe default).
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

  // Attempt 1.
  const first = await runEvalAttempt(args, prompt, 1);
  const firstDecision = decideAfterAttempt(first, /*isRetry*/ false);
  if (firstDecision.kind === 'verdict') {
    if (first.crashed) {
      log.warn(
        `eval SDK crashed (${first.error?.message ?? 'unknown'}) AFTER emitting verdict; honouring it`,
      );
    }
    return await emitVerdict(args, firstDecision.verdict);
  }
  if (firstDecision.kind === 'fall-through') {
    log.warn('eval returned no parseable verdict; treating as not passed');
    return await emitVerdict(args, firstDecision.verdict);
  }

  // firstDecision.kind === 'retry' — first attempt crashed before any
  // parseable verdict was emitted. This is the S-019 recovery path.
  log.warn(
    `eval SDK crashed (${first.error?.message ?? 'unknown'}) before emitting verdict; retrying once`,
  );
  await args.events.emit({
    iter: args.iteration,
    phase: 'eval',
    kind: 'error',
    msg: `attempt 1 crashed before verdict; retrying: ${first.error?.message ?? 'unknown'}`,
  });

  const second = await runEvalAttempt(args, prompt, 2);
  const secondDecision = decideAfterAttempt(second, /*isRetry*/ true, first.error);
  if (secondDecision.kind === 'verdict' && second.crashed) {
    log.warn(
      `eval retry SDK crashed (${second.error?.message ?? 'unknown'}) AFTER emitting verdict; honouring it`,
    );
  }
  if (secondDecision.kind === 'fall-through') {
    log.warn('eval retry also failed to emit a parseable verdict; treating as not passed');
  }
  // Retry path can only return 'verdict' or 'fall-through' (never 'retry').
  return await emitVerdict(
    args,
    secondDecision.kind === 'retry'
      ? { passed: false, summary: 'unreachable', blockers: [] }
      : secondDecision.verdict,
  );
}

export interface EvalAttempt {
  transcript: string;
  crashed: boolean;
  error?: Error;
}

export type EvalDecision =
  | { kind: 'verdict'; verdict: EvalVerdict }
  | { kind: 'retry' }
  | { kind: 'fall-through'; verdict: EvalVerdict };

/**
 * Pure decision function — given an attempt result, decide whether to:
 *   - 'verdict':       a parseable verdict was emitted; honour it (even
 *                      if the SDK process crashed AFTER the JSON block
 *                      streamed through).
 *   - 'retry':         attempt crashed BEFORE emitting a verdict; the
 *                      caller should retry once.
 *   - 'fall-through':  no verdict and either (a) attempt finished cleanly
 *                      with no JSON, or (b) this is the retry attempt and
 *                      we've exhausted budget. Use the not-passed fallback.
 *
 * Decoupled from the SDK side-effects so retry semantics can be unit-
 * tested without spawning a Claude Code subprocess. `isRetry=true`
 * disables further retries (the second-attempt branch).
 */
export function decideAfterAttempt(
  attempt: EvalAttempt,
  isRetry: boolean,
  priorError?: Error,
): EvalDecision {
  const verdict = extractEvalVerdict(attempt.transcript);
  if (verdict) return { kind: 'verdict', verdict };

  if (!attempt.crashed) {
    // Clean finish, no JSON. Don't retry — re-running the same prompt
    // with the same model is unlikely to produce different content.
    return {
      kind: 'fall-through',
      verdict: {
        passed: false,
        summary: 'Eval did not return structured output; treating as not passed (refusing to ship).',
        blockers: ['Re-run eval; ensure it produces a fenced JSON block.'],
      },
    };
  }

  // Crashed without verdict.
  if (!isRetry) return { kind: 'retry' };

  // Already retried; both attempts crashed.
  const last = attempt.error ?? priorError;
  return {
    kind: 'fall-through',
    verdict: {
      passed: false,
      summary: `Eval crashed twice without emitting a verdict (last error: ${last?.message ?? 'unknown'}); refusing to ship.`,
      blockers: ['Eval crashed twice; re-run is needed before shipping.'],
    },
  };
}

/**
 * Single eval session attempt. Returns whatever transcript was
 * collected, plus a `crashed` flag if the underlying SDK/runtime
 * process exited non-zero or otherwise threw mid-stream. Never
 * re-throws — the caller decides whether to retry or fall through.
 */
async function runEvalAttempt(args: EvalArgs, prompt: string, attemptNum: number): Promise<EvalAttempt> {
  const transcript: string[] = [];
  if (attemptNum > 1) {
    await args.events.emit({
      iter: args.iteration,
      phase: 'eval',
      kind: 'start',
      msg: `attempt ${attemptNum} (retry after crash)`,
    });
  }
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
    return { transcript: transcript.join('\n'), crashed: false };
  } catch (err) {
    await args.events.emit({
      iter: args.iteration,
      phase: 'eval',
      kind: 'error',
      msg: (err as Error).message,
    });
    return { transcript: transcript.join('\n'), crashed: true, error: err as Error };
  }
}

async function emitVerdict(args: EvalArgs, verdict: EvalVerdict): Promise<EvalVerdict> {
  await args.events.emit({
    iter: args.iteration,
    phase: 'eval',
    kind: 'verdict',
    msg: verdict.passed ? 'PASSED' : `${verdict.blockers.length} blocker(s)`,
    data: { verdict },
  });
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
