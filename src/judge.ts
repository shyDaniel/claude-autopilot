import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  const turn1 = await runJudgeTurn(args, prompt, transcript, /* isRetry */ false);

  let parsed = extractVerdict(transcript.join('\n'));

  // S-022: judge sometimes finishes a long, productive session without tailing
  // its output with the required fenced JSON block. Retry once with a tight
  // JSON-only re-prompt that quotes the judge's own concluding prose, so the
  // model just has to re-emit the structured form. Previously the loop fell
  // straight through to a synthesized fallback that discarded ~50 turns of
  // analysis and surfaced a misleading "FINAL_GOAL.md missing" outstanding.
  //
  // S-023: also retry when the SDK finished with `error_max_turns` etc., even
  // before checking the parser — that signal tells us the judge was cut off
  // mid-thought, which is exactly when the JSON-only follow-up has the most
  // value. Without this, we'd only retry on the symptom (no parseable JSON)
  // and miss the chance to surface a clear "judge ran out of budget" log line.
  if (!parsed) {
    const reason = describeRetryReason(turn1);
    const retryPrompt = buildJsonOnlyRetryPrompt(transcript.join('\n'));
    if (retryPrompt) {
      log.warn(`judge: ${reason}; retrying with JSON-only re-prompt`);
      await args.events.emit({
        iter: args.iteration,
        phase: 'judge',
        kind: 'start',
        msg: `attempt 2 (JSON-only retry: ${reason})`,
      });
      await runJudgeTurn(args, retryPrompt, transcript, /* isRetry */ true);
      parsed = extractVerdict(transcript.join('\n'));
    }
  }

  const verdict = parsed ?? synthesizeFallbackVerdict(transcript.join('\n'), args.repoPath);

  await args.events.emit({
    iter: args.iteration,
    phase: 'judge',
    kind: 'verdict',
    msg: verdict.done ? 'DONE' : `${verdict.outstanding.length} outstanding`,
    data: { verdict },
  });

  if (!parsed) log.warn('judge returned no parseable verdict; synthesized fallback from transcript');
  return verdict;
}

/**
 * Describe why the JSON-only retry is firing, for both the human-facing log
 * line and the events.jsonl audit trail. Three buckets:
 *   - "no fenced JSON in transcript" (clean finish, model just forgot the
 *     wrap-up — the original S-022 trigger)
 *   - "judge SDK ended with `<subtype>`" (max turns, max budget, runtime
 *     error — the S-023 addition; tells the operator the judge was cut off
 *     rather than chose not to emit JSON)
 *   - "judge crashed before completing" (no result message at all, e.g.
 *     `error_during_execution` propagated as a thrown error caught by the
 *     wrapper)
 *
 * Pure function — exported for testing.
 */
export function describeRetryReason(turn: JudgeTurnResult): string {
  if (turn.crashed) return 'judge crashed before completing';
  if (turn.endSubtype && turn.endSubtype !== 'success') {
    return `judge SDK ended with \`${turn.endSubtype}\``;
  }
  return 'no fenced JSON in transcript';
}

/**
 * Outcome of a single SDK invocation. `endSubtype` mirrors the SDK's
 * `result.subtype` ('success' | 'error_max_turns' | …) so the caller can
 * decide whether to retry, and lets `events.jsonl` record exactly why a
 * retry fired. `crashed` is set when the SDK threw before producing a
 * result message at all (and the wrapper swallowed the throw on a retry).
 */
export interface JudgeTurnResult {
  endSubtype?: string;
  crashed: boolean;
}

async function runJudgeTurn(
  args: JudgeArgs,
  prompt: string,
  transcript: string[],
  isRetry: boolean,
): Promise<JudgeTurnResult> {
  let endSubtype: string | undefined;
  let crashed = false;
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
        // Codex transcripts don't carry an SDK-style subtype; treat a clean
        // return as 'success'. If runCodexExec ever surfaces a crash flag we
        // can wire it through here without changing the caller.
        endSubtype = 'success';
        return;
      }

      // Retry turn is JSON-only: cap turns hard so a chatty model can't burn
      // budget re-walking the repo. The retry prompt itself contains the
      // judge's prior conclusion to summarize.
      const turnsCap = isRetry ? 2 : args.maxTurns;

      const options: Options = {
        cwd: args.repoPath,
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        model,
        mcpServers: args.mcpServers,
        // S-256: see worker.ts — `--strict-mcp-config` is required so the
        // merged `mcpServers` map wins over Claude Code's silent .mcp.json
        // gating. Without it the judge cannot reach playwright /
        // chrome-devtools MCPs in repos that ship a .mcp.json with the
        // overrides baked in (the trust dialog never runs headless).
        strictMcpConfig: true,
        ...(turnsCap ? { maxTurns: turnsCap } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          // S-023: hammer the JSON-tail requirement. After 100+ tool turns of
          // analysis, the model tends to forget the format demand at the very
          // end and just stop with prose. Reinforced phrasing here is the
          // single most effective cheap fix; the JSON-only retry below is the
          // belt-and-suspenders.
          append:
            'You are the JUDGE in an agent-autopilot loop. Be uncompromising. ' +
            'CRITICAL OUTPUT REQUIREMENT: Your FINAL message MUST end with a single ' +
            "fenced ```json block containing {done, summary, outstanding[]}. " +
            'No prose, commentary, or markdown after the closing ``` fence. ' +
            'If you finish your investigation, immediately emit the JSON block — ' +
            "do not write 'Now I'll write up my findings' or similar; just emit the JSON.",
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
        if ((msg as { type?: string }).type === 'result') {
          const r = msg as unknown as { subtype?: string };
          if (r.subtype) endSubtype = r.subtype;
        }
      }
    });
  } catch (err) {
    crashed = true;
    await args.events.emit({
      iter: args.iteration,
      phase: 'judge',
      kind: 'error',
      msg: (err as Error).message,
    });
    if (!isRetry) throw err;
    // On retry crash, swallow — caller checks parsed status afterwards and
    // synthesizes a fallback verdict from whatever transcript exists.
  }
  return { endSubtype, crashed };
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

/**
 * Build a tightly-scoped follow-up prompt that asks the judge to re-emit its
 * conclusion as a fenced JSON block. Includes the last ~3000 chars of prose
 * so the model has its own analysis to summarize without re-reading the repo.
 *
 * Returns null if the transcript is too short to be worth retrying — the
 * judge probably crashed before saying anything substantive, in which case
 * the JSON-only follow-up has no signal to work from and the caller should
 * fall straight through to the synthesized fallback.
 *
 * Pure function — exported for testing.
 */
export function buildJsonOnlyRetryPrompt(transcript: string): string | null {
  const tail = lastProseChunks(transcript, 3000);
  if (tail.trim().length < 80) return null;
  return [
    'Your previous analysis did not end with a fenced JSON block, so it could not be',
    'parsed. Read your own analysis below and emit ONLY the structured verdict now.',
    '',
    'CRITICAL: Your entire response this turn must be a single fenced ```json block,',
    'with NO prose before or after it. Do not run any tools. Do not re-investigate.',
    'Just convert your conclusion below into the structured shape:',
    '',
    '```json',
    '{',
    '  "done": false,',
    '  "summary": "<one paragraph from your conclusion>",',
    '  "outstanding": ["<short bullet>", "..."]',
    '}',
    '```',
    '',
    '`outstanding` MUST be an array of strings (use [] when done is true).',
    'If your analysis concluded the repo is shippable, set done: true and outstanding: [].',
    '',
    '--- YOUR PRIOR ANALYSIS (tail) ---',
    tail,
    '--- END OF PRIOR ANALYSIS ---',
    '',
    'Now emit the fenced JSON block, and nothing else.',
  ].join('\n');
}

/**
 * Build an honest fallback verdict when even the retry fails to produce a
 * parseable JSON. Preserves the judge's prose conclusion so the next iteration
 * has actionable context, and surfaces the real failure mode (parse failure,
 * not "FINAL_GOAL.md missing or malformed" — that bullet was misleading and
 * routinely sent the worker chasing a phantom problem when the underlying
 * cause was simply the judge forgetting to tail with fenced JSON).
 *
 * Three branches:
 *  - FINAL_GOAL.md genuinely missing → bullet says so. This is the only case
 *    where the old fallback's "FINAL_GOAL.md present and well-formed" wording
 *    was actually correct.
 *  - Transcript empty / near-empty → bullet says judge produced no analysis.
 *  - Transcript has prose but no JSON → preserve the prose tail in summary,
 *    bullet says JSON missing (NOT FINAL_GOAL.md).
 *
 * Pure function — exported for testing.
 */
export function synthesizeFallbackVerdict(transcript: string, repoPath: string): Verdict {
  const finalGoalExists = existsSync(join(repoPath, 'FINAL_GOAL.md'));
  const proseTail = lastProseChunks(transcript, 1200).trim();
  const transcriptIsEmpty = proseTail.length < 40;

  if (!finalGoalExists) {
    // Missing-goal is a genuinely distinct failure mode worth surfacing.
    return {
      done: false,
      summary: 'FINAL_GOAL.md is missing from the repo root — judge cannot evaluate without a goal.',
      outstanding: [
        'Create FINAL_GOAL.md at the repo root describing the project goal and acceptance criteria.',
      ],
    };
  }

  if (transcriptIsEmpty) {
    return {
      done: false,
      summary:
        'Judge session ended without producing any substantive prose or a fenced JSON verdict. ' +
        'Likely a model-side error or empty session — re-run on next iteration.',
      outstanding: [
        'Judge produced no analysis this iteration; re-run is needed before ranking work.',
      ],
    };
  }

  // Have transcript prose but no parseable JSON, even after retry. Preserve
  // the judge's conclusion verbatim so it isn't lost.
  return {
    done: false,
    summary:
      'Judge transcript ended with prose instead of the required fenced JSON verdict, and ' +
      'the JSON-only retry also failed to produce parseable output. The judge\'s analysis is ' +
      `preserved below: ${proseTail}`,
    outstanding: [
      'Judge analysis did not include a fenced JSON verdict; re-run judge so its conclusions ' +
        'land in the parseable form. Until then, treat the prose summary as advisory.',
    ],
  };
}

/**
 * Extract the last ~N characters of substantive prose from a transcript.
 * Filters out tool-use marker lines (`[tool: …]`) and thinking-block markers
 * we appended in transcript.ts so the tail is likely to contain the model's
 * actual conclusion text rather than tool dispatch noise.
 *
 * Exported for testing only.
 */
export function lastProseChunks(transcript: string, maxChars: number): string {
  if (!transcript) return '';
  const cleaned = transcript
    .split('\n')
    .filter((line) => !line.startsWith('[tool:') && line.trim() !== '[thinking]')
    .join('\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return '…' + cleaned.slice(cleaned.length - maxChars);
}
