import { resolve } from 'node:path';
import kleur from 'kleur';
import { readStatus, isProcessAlive } from '../status.js';

export async function statusCommand(repoArg: string): Promise<number> {
  const repo = resolve(repoArg);
  const s = await readStatus(repo);
  if (!s) {
    console.log(kleur.yellow(`no status file at ${repo}/.autopilot/status.json`));
    console.log('  → autopilot has never run here, or `.autopilot` was cleaned.');
    return 1;
  }
  const alive = isProcessAlive(s.pid);
  const aliveLabel = alive ? kleur.green('alive') : kleur.gray('stopped');
  const phaseColor = colorPhase(s.phase);

  console.log(kleur.bold().cyan('claude-autopilot status'));
  console.log(`  repo:           ${s.repo}`);
  console.log(`  pid:            ${s.pid} (${aliveLabel})`);
  console.log(`  started:        ${s.startedAt}`);
  console.log(`  updated:        ${s.updatedAt}`);
  console.log(`  iteration:      ${kleur.bold(String(s.iteration))}${s.maxIterations ? ` / ${s.maxIterations}` : ''}`);
  console.log(`  phase:          ${phaseColor}`);
  if (s.currentAction) console.log(`  current action: ${s.currentAction}`);
  console.log(`  commits made:   ${s.commitsSinceStart}`);
  console.log(`  stagnation:     ${s.stagnantIterations} / ${s.stagnationThreshold}`);
  if (s.lastVerdict) {
    console.log('');
    console.log(kleur.bold('  last verdict:'));
    console.log(`    done:          ${s.lastVerdict.done ? kleur.green('true') : kleur.red('false')}`);
    console.log(`    at:            ${s.lastVerdict.at}`);
    console.log(`    outstanding:   ${s.lastVerdict.outstandingCount}`);
    console.log(`    summary:       ${truncate(s.lastVerdict.summary, 200)}`);
  }
  if (s.stopReason) {
    console.log('');
    console.log(`  stop reason:    ${kleur.bold(s.stopReason)}${s.stopMessage ? ' — ' + s.stopMessage : ''}`);
  }
  return 0;
}

function colorPhase(phase: string): string {
  switch (phase) {
    case 'judging':
      return kleur.blue(phase);
    case 'working':
      return kleur.magenta(phase);
    case 'starting':
      return kleur.cyan(phase);
    case 'stopped':
      return kleur.gray(phase);
    default:
      return phase;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
