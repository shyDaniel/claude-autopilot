import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from './logging.js';
import type { EventLog } from './events.js';
import type { StatusWriter } from './status.js';
import type { McpServerConfig } from './mcp.js';

export interface CodexExecArgs {
  repoPath: string;
  label: 'judge' | 'worker' | 'refine';
  iteration: number;
  model: string;
  prompt: string;
  mode: 'judge' | 'worker';
  verbose: boolean;
  events?: EventLog;
  status?: StatusWriter;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface CodexExecResult {
  completedTurns: number;
  finalText: string;
  transcript: string;
}

export async function runCodexExec(args: CodexExecArgs): Promise<CodexExecResult> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-codex-'));
  const lastMessagePath = join(dir, `${args.label}-last-message.md`);
  const codexBin = process.env.CODEX_BIN ?? 'codex';
  const cliArgs = [
    'exec',
    '-C',
    args.repoPath,
    '--skip-git-repo-check',
    '--model',
    args.model,
    '--output-last-message',
    lastMessagePath,
    '--color',
    'never',
    '-c',
    'web_search="live"',
    '-c',
    'model_reasoning_effort="xhigh"',
    ...codexMcpConfigArgs(args.mcpServers ?? {}),
    ...modeArgs(args.mode),
    '-',
  ];

  log.dim(`  [${args.label}] codex exec model=${args.model} mode=${args.mode}`);
  const transcript: string[] = [`$ ${codexBin} ${redactArgsForTranscript(cliArgs).join(' ')}`];

  const child = spawn(codexBin, cliArgs, {
    cwd: args.repoPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdin.end(args.prompt);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk: string) => {
    collectCodexOutput(chunk, 'stdout', args, transcript);
  });
  child.stderr.on('data', (chunk: string) => {
    collectCodexOutput(chunk, 'stderr', args, transcript);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  if (exit.error || exit.signal || exit.code !== 0) {
    const tail = transcript.slice(-20).join('\n');
    throw new Error(`codex exec failed (${exit.error?.message ?? exit.signal ?? `exit ${exit.code}`}):\n${tail}`);
  }

  const finalText = await readLastMessage(lastMessagePath, transcript.join('\n'));
  const fullTranscript = [...transcript, '\n[final]\n', finalText].join('\n');
  return {
    completedTurns: 1,
    finalText,
    transcript: fullTranscript,
  };
}

export function codexMcpConfigArgs(mcpServers: Record<string, McpServerConfig>): string[] {
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    const prefix = `mcp_servers.${tomlDottedSegment(name)}`;
    out.push('-c', `${prefix}.command=${tomlString(cfg.command)}`);
    if (cfg.args?.length) out.push('-c', `${prefix}.args=${tomlArray(cfg.args)}`);
    if (cfg.env && Object.keys(cfg.env).length > 0) {
      out.push('-c', `${prefix}.env=${tomlInlineTable(cfg.env)}`);
    }
  }
  return out;
}

function modeArgs(mode: 'judge' | 'worker'): string[] {
  if (mode === 'judge') {
    return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
  }
  return ['--dangerously-bypass-approvals-and-sandbox', '--ask-for-approval', 'never'];
}

function collectCodexOutput(
  chunk: string,
  stream: 'stdout' | 'stderr',
  args: CodexExecArgs,
  transcript: string[],
): void {
  const text = chunk.replace(/\r/g, '');
  transcript.push(text);
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return;

  if (args.verbose) {
    for (const line of text.split('\n').filter(Boolean)) {
      log.dim(`  [${args.label}:${stream}] ${truncate(line, 240)}`);
    }
  } else {
    log.dim(`  [${args.label}] ${truncate(first, 180)}`);
  }

  void args.events?.emit({
    iter: args.iteration,
    phase: args.label === 'refine' ? 'loop' : args.label,
    kind: 'text',
    msg: truncate(first, 240),
    data: { stream },
  });
  void args.status?.update({
    currentAction: `${args.label}: ${truncate(first, 80)}`,
  });
}

async function readLastMessage(path: string, fallback: string): Promise<string> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

function tomlDottedSegment(value: string): string {
  return /^[A-Za-z0-9_]+$/.test(value) ? value : tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${tomlDottedSegment(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

function redactArgsForTranscript(args: string[]): string[] {
  return args.map((arg) => (arg.includes('.env=') ? arg.replace(/\.env=.*/, '.env=<redacted>') : arg));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}
