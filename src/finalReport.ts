import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import kleur from 'kleur';
import type { Verdict } from './judge.js';
import type { AutopilotState } from './state.js';
import type { ServiceHandle } from './service.js';

export interface FinalReportInput {
  repoPath: string;
  state: AutopilotState;
  verdict: Verdict;
  service: ServiceHandle | null;
  serviceError?: string;
}

export interface FinalReport {
  path: string;
  markdown: string;
  oneLiner: string;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function gitCommitsSince(repoPath: string, sinceIso: string): string[] {
  if (!existsSync(join(repoPath, '.git'))) return [];
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'log', '--oneline', '--no-color', `--since=${sinceIso}`],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function firstSentence(text: string): string {
  // Split on Chinese or English terminal punctuation, take first reasonably-sized chunk.
  const parts = text.split(/(?<=[.。!?!?])\s+/);
  const pick = parts[0]?.trim() ?? text.trim();
  return pick.length > 240 ? pick.slice(0, 239) + '…' : pick;
}

export async function writeFinalReport(i: FinalReportInput): Promise<FinalReport> {
  const name = basename(i.repoPath);
  const startedAt = new Date(i.state.startedAt);
  const duration = formatDuration(Date.now() - startedAt.getTime());
  const commits = gitCommitsSince(i.repoPath, i.state.startedAt);

  const lines: string[] = [];
  lines.push(`# Shipped: ${name}`);
  lines.push('');
  lines.push(
    `**${i.state.iteration} iteration${i.state.iteration === 1 ? '' : 's'} · ${commits.length} commit${commits.length === 1 ? '' : 's'} · ${duration}**`,
  );
  lines.push('');
  lines.push(i.verdict.summary);
  lines.push('');

  if (i.service) {
    lines.push('## Service restarted for inspection');
    lines.push('');
    lines.push(`- Command: \`${i.service.cmd}\``);
    lines.push(`- PID: ${i.service.pid}`);
    lines.push(`- Log: \`${i.service.logPath}\``);
    lines.push('');
    lines.push('Tail the log:');
    lines.push('');
    lines.push('```bash');
    lines.push(`tail -f ${i.service.logPath}`);
    lines.push('```');
    lines.push('');
    lines.push('Stop the service:');
    lines.push('');
    lines.push('```bash');
    lines.push(`kill ${i.service.pid}`);
    lines.push('```');
    lines.push('');
  } else if (i.serviceError) {
    lines.push('## Service not restarted');
    lines.push('');
    lines.push(i.serviceError);
    lines.push('');
  }

  if (commits.length > 0) {
    lines.push(`## Commits landed this run (${commits.length})`);
    lines.push('');
    for (const c of commits.slice(0, 30)) lines.push(`- ${c}`);
    if (commits.length > 30) lines.push(`- …and ${commits.length - 30} more`);
    lines.push('');
  }

  if (i.state.refinementsSoFar > 0) {
    lines.push('## Self-refinements');
    lines.push('');
    lines.push(
      `Autopilot refined its own prompts/source ${i.state.refinementsSoFar} time${
        i.state.refinementsSoFar === 1 ? '' : 's'
      } during this run.`,
    );
    lines.push('');
  }

  lines.push('## Verify');
  lines.push('');
  lines.push(`- All per-iteration artifacts: \`${join(i.repoPath, '.autopilot', 'iterations')}\``);
  lines.push(`- Live event stream: \`${join(i.repoPath, '.autopilot', 'events.jsonl')}\``);
  lines.push('');

  const markdown = lines.join('\n');
  const path = join(i.repoPath, '.autopilot', 'FINAL_REPORT.md');
  await writeFile(path, markdown, 'utf8');

  const oneLiner = `Shipped ${name}: ${i.state.iteration} iter, ${commits.length} commits, ${duration}. ${firstSentence(i.verdict.summary)}`;

  return { path, markdown, oneLiner };
}

export function printBanner(input: {
  repoPath: string;
  state: AutopilotState;
  verdict: Verdict;
  service: ServiceHandle | null;
  serviceError?: string;
  reportPath: string;
}): void {
  const name = basename(input.repoPath);
  const duration = formatDuration(Date.now() - new Date(input.state.startedAt).getTime());
  const commits = gitCommitsSince(input.repoPath, input.state.startedAt).length;
  const first = firstSentence(input.verdict.summary);

  const rule = kleur.green('═'.repeat(68));
  console.log('');
  console.log(rule);
  console.log(
    '  ' + kleur.bold().green('✓ SHIPPED') + '  ' + kleur.bold().white(name),
  );
  console.log(
    '  ' +
      kleur.gray(
        `${input.state.iteration} iter · ${commits} commits · ${duration}` +
          (input.state.refinementsSoFar > 0
            ? ` · ${input.state.refinementsSoFar} self-refinement${input.state.refinementsSoFar === 1 ? '' : 's'}`
            : ''),
      ),
  );
  console.log(rule);
  console.log('');
  wrap(first, 66).forEach((l) => console.log('  ' + l));
  console.log('');
  if (input.service) {
    console.log('  ' + kleur.cyan('▶ running:  ') + input.service.cmd);
    console.log('  ' + kleur.cyan('  pid:      ') + input.service.pid);
    console.log('  ' + kleur.cyan('  log:      ') + input.service.logPath);
  } else if (input.serviceError) {
    console.log('  ' + kleur.yellow('⚠ service not restarted: ') + input.serviceError);
  }
  console.log('  ' + kleur.gray('  report:   ') + input.reportPath);
  console.log('');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/);
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) out.push(line);
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line) out.push(line);
  return out;
}
