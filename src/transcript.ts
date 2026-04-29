import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';

export interface PrintContext {
  label: 'judge' | 'worker' | 'eval' | 'orchestrate';
  iteration: number;
  verbose: boolean;
  events: EventLog;
  status: StatusWriter;
  transcript: string[];
}

/**
 * Emit a single SDK message to all three sinks: the transcript buffer (for
 * later iteration artifacts), the event log (for `autopilot watch`), and
 * stdout (so the user can see Claude think live).
 *
 * In non-verbose mode, only the first non-empty line of each text block and a
 * one-line tool summary are printed. In verbose mode, the full text block and
 * the full (sanitized) tool input are printed.
 */
export async function printMessage(msg: SDKMessage, ctx: PrintContext): Promise<number> {
  switch (msg.type) {
    case 'system': {
      const anyMsg = msg as unknown as { subtype?: string; model?: string; session_id?: string };
      if (anyMsg.subtype === 'init') {
        const modelStr = anyMsg.model ? ` model=${anyMsg.model}` : '';
        const sid = anyMsg.session_id ? ` sid=${anyMsg.session_id.slice(0, 8)}` : '';
        log.dim(`  [${ctx.label}] session started${modelStr}${sid}`);
      }
      return 0;
    }
    case 'assistant': {
      const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content as Array<BlockLike>) {
        await handleBlock(block, ctx);
      }
      return 1;
    }
    case 'user': {
      // Show tool_result echoes briefly — helps confirm tools actually return.
      if (ctx.verbose) {
        const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
        for (const block of content as Array<BlockLike>) {
          if (block.type === 'tool_result') {
            const text = stringifyResult(block.content);
            const preview = truncate(firstLine(text) ?? '(empty)', 200);
            log.dim(`    ↳ result: ${preview}`);
          }
        }
      }
      return 0;
    }
    case 'result': {
      const r = msg as unknown as { subtype?: string; num_turns?: number; result?: string };
      log.dim(`  [${ctx.label}] result: ${r.subtype ?? 'ok'} (turns=${r.num_turns ?? '?'})`);
      if (r.result) ctx.transcript.push(r.result);
      return 0;
    }
    default:
      return 0;
  }
}

interface BlockLike {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

async function handleBlock(block: BlockLike, ctx: PrintContext): Promise<void> {
  if (block.type === 'thinking' && block.thinking) {
    // Extended thinking — always show a short prefix so user knows Claude is
    // reasoning even before a tool use.
    ctx.transcript.push(`\n[thinking]\n${block.thinking}`);
    if (ctx.verbose) {
      printLines(`  [${ctx.label}:think]`, block.thinking, 12);
    } else {
      const fl = firstLine(block.thinking);
      if (fl) log.dim(`  [${ctx.label}:think] ${truncate(fl, 180)}`);
    }
    return;
  }

  if (block.type === 'text' && block.text) {
    ctx.transcript.push(block.text);
    const fl = firstLine(block.text) ?? '';
    if (ctx.verbose) {
      printLines(`  [${ctx.label}]`, block.text, 40);
    } else if (fl) {
      log.dim(`  [iter ${ctx.iteration}] ${truncate(fl, 180)}`);
    }
    if (fl) {
      await ctx.events.emit({
        iter: ctx.iteration,
        phase: ctx.label,
        kind: 'text',
        msg: truncate(fl, 240),
      });
      await ctx.status.update({
        currentAction: `${ctx.label} thinking: ${truncate(fl, 80)}`,
      });
    }
    return;
  }

  if (block.type === 'tool_use') {
    const name = block.name ?? 'tool';
    const preview = previewInput(block.input);
    if (ctx.verbose) {
      log.step(`  [${ctx.label}] tool: ${name}`);
      const full = fullInput(block.input);
      if (full) log.raw(indent(full, '      '));
    } else {
      log.step(`  [iter ${ctx.iteration}] tool: ${name} ${preview}`);
    }
    ctx.transcript.push(`\n[tool: ${name}] ${preview}`);
    await ctx.events.emit({
      iter: ctx.iteration,
      phase: ctx.label,
      kind: 'tool',
      msg: name,
      data: { input: sanitize(block.input) },
    });
    await ctx.status.update({ currentAction: `${ctx.label} tool: ${name}` });
  }
}

function firstLine(s: string): string | undefined {
  return s.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
}

function printLines(prefix: string, text: string, maxLines: number): void {
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  for (const line of shown) log.dim(`${prefix} ${line}`);
  if (lines.length > maxLines) log.dim(`${prefix} … (${lines.length - maxLines} more lines)`);
}

function indent(s: string, p: string): string {
  return s.split('\n').map((l) => p + l).join('\n');
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

function fullInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '';
  }
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

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c && 'text' in (c as object) ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
