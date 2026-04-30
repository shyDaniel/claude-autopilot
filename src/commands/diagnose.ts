import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { join, resolve } from 'node:path';
import kleur from 'kleur';
import { log } from '../logging.js';
import { buildSummary, readEvents, type IterationSummary, type RunSummary } from './report.js';

export type Health = 'HEALTHY' | 'SLOWING' | 'STUCK' | 'CRASHED' | 'SHIPPED';
export type Liveness = 'running' | 'stopped' | 'stale';
export type Severity = 'info' | 'warn' | 'critical';

export interface Anomaly {
  rule: string;
  severity: Severity;
  message: string;
  iters?: number[];
  recommendation?: string;
}

export interface DiagnoseResult {
  health: Health;
  liveness: Liveness;
  pid?: number;
  pidAlive: boolean;
  lastEventTs?: string;
  secondsSinceLastEvent?: number;
  stopReason?: string;
  finalState?: string;
  anomalies: Anomaly[];
  summary: RunSummary;
}

export interface DiagnoseOptions {
  json?: boolean;
  watch?: boolean;
}

interface StatusFile {
  pid?: number;
  phase?: string;
  stopReason?: string;
  stopMessage?: string;
  lastVerdict?: { done?: boolean; outstandingCount?: number };
}

interface StateFile {
  errors?: { at: string; message: string }[];
  refinementsSoFar?: number;
}

export async function diagnoseCommand(repo: string, opts: DiagnoseOptions): Promise<number> {
  const repoAbs = resolve(repo);
  const eventsPath = join(repoAbs, '.autopilot', 'events.jsonl');
  if (!existsSync(eventsPath)) {
    log.err(`no autopilot events at ${eventsPath} — has autopilot ever run on this repo?`);
    return 1;
  }

  const render = (): void => {
    const result = diagnose(repoAbs);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderTerminal(result) + '\n');
    }
  };

  render();

  if (opts.watch) {
    log.info('--watch: redrawing every 30s on events.jsonl change (Ctrl-C to exit)');
    let lastSize = statSync(eventsPath).size;
    const onChange = (): void => {
      const size = statSync(eventsPath).size;
      if (size === lastSize) return;
      lastSize = size;
      process.stdout.write('\x1b[2J\x1b[H');
      render();
    };
    watchFile(eventsPath, { interval: 30_000 }, onChange);
    await new Promise<void>((r) => process.on('SIGINT', () => { unwatchFile(eventsPath); r(); }));
  }
  return 0;
}

export function diagnose(repoAbs: string): DiagnoseResult {
  const eventsPath = join(repoAbs, '.autopilot', 'events.jsonl');
  const statusPath = join(repoAbs, '.autopilot', 'status.json');
  const statePath = join(repoAbs, '.autopilot', 'state.json');

  const events = readEvents(eventsPath);
  const summary = buildSummary(events, repoAbs);
  const status = readJson<StatusFile>(statusPath) ?? {};
  const state = readJson<StateFile>(statePath) ?? {};

  const pid = status.pid;
  const pidAlive = pid !== undefined ? isPidAlive(pid) : false;
  const lastEventTs = events[events.length - 1]?.ts;
  const secondsSinceLastEvent = lastEventTs
    ? Math.floor((Date.now() - new Date(lastEventTs).getTime()) / 1000)
    : undefined;

  const liveness: Liveness = (() => {
    if (!pid) return 'stopped';
    if (!pidAlive) return 'stopped';
    if (secondsSinceLastEvent !== undefined && secondsSinceLastEvent > 300) return 'stale';
    return 'running';
  })();

  const anomalies: Anomaly[] = [];

  // Rule 1: stale process — alive but no events for > 5 min.
  if (liveness === 'stale') {
    anomalies.push({
      rule: 'stale_process',
      severity: 'critical',
      message: `pid ${pid} is alive but no events written in ${secondsSinceLastEvent}s (threshold 300s) — process may be hung in a tool call or upstream API`,
      recommendation: `inspect last events with \`autopilot watch ${repoAbs}\`; if hung, kill ${pid} and re-launch with --resume`,
    });
  }

  // Rule 2: judge unparseable verdict rate.
  const lastN = summary.iterations.slice(-10);
  const unparsed = lastN.filter((it) => it.judgeDone === undefined && it.endMsg !== 'dry_run');
  if (lastN.length >= 5 && unparsed.length / lastN.length > 0.15) {
    anomalies.push({
      rule: 'judge_unparseable_rate',
      severity: 'warn',
      message: `judge produced no parseable verdict in ${unparsed.length}/${lastN.length} of the last iterations (>15%)`,
      iters: unparsed.map((it) => it.iter),
      recommendation: 'verify the judge SKILL.md prompt is producing fenced JSON; check src/judge.ts for SDK exit-code handling regressions',
    });
  }

  // Rule 3: iteration time outliers.
  const durations = summary.iterations.map((it) => it.durationMs).filter((d): d is number => d !== undefined && d > 0);
  if (durations.length >= 5) {
    const median = medianOf(durations);
    const longCutoff = Math.max(median * 3, 30 * 60_000);
    const outliers = summary.iterations.filter(
      (it) => it.durationMs !== undefined && it.durationMs > longCutoff,
    );
    if (outliers.length > 0) {
      anomalies.push({
        rule: 'iter_time_outlier',
        severity: 'info',
        message: `${outliers.length} iteration(s) ran >3× the median (${humanDur(median)}); longest = iter ${outliers.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0].iter} (${humanDur(outliers[0].durationMs ?? 0)})`,
        iters: outliers.map((it) => it.iter),
        recommendation: 'review the worker transcripts in `.autopilot/iterations/NNNNNN/worker-transcript.md` for repeated tool calls or stuck network operations',
      });
    }
  }

  // Rule 4: SDK error clusters.
  const errs = state.errors ?? [];
  const oneHourAgo = Date.now() - 60 * 60_000;
  const recentSdkErrs = errs.filter(
    (e) => /Claude Code process exited with code/.test(e.message) && new Date(e.at).getTime() > oneHourAgo,
  );
  if (recentSdkErrs.length >= 3) {
    anomalies.push({
      rule: 'sdk_error_cluster',
      severity: 'warn',
      message: `${recentSdkErrs.length} SDK \`process exited with code 1\` errors in the last hour`,
      recommendation: 'check rate-limit / quota / network: `grep -c "rate_limit\\|overload" .autopilot/events.jsonl`; consider --worker-fallback-model claude-sonnet-4-6',
    });
  }

  // Rule 5: evolve storms — 3+ consecutive evolves within 30 min.
  const refs = summary.refinements;
  for (let i = 0; i + 2 < refs.length; i++) {
    const start = new Date(refs[i].ts).getTime();
    const end = new Date(refs[i + 2].ts).getTime();
    if (end - start <= 30 * 60_000) {
      anomalies.push({
        rule: 'evolve_storm',
        severity: 'warn',
        message: `3+ refinements landed within 30 min (refinements #${refs[i].number}-#${refs[i + 2].number}) — autopilot may need a structural fix, not more SKILL.md prose`,
        iters: [refs[i].iter, refs[i + 1].iter, refs[i + 2].iter],
        recommendation: 'inspect `.autopilot/refinements/NNN/transcript.md` for the three runs; if all three edited the same skill file, the next evolve should consider a system-prompt-level fix in src/',
      });
      break;
    }
  }

  // Rule 6: worker no-op iterations.
  const noopIters = summary.iterations.filter(
    (it) => it.workerRan && it.commitsLanded === 0 && it.workerToolCount > 0,
  );
  const recentNoops = noopIters.slice(-5);
  if (recentNoops.length >= 2) {
    anomalies.push({
      rule: 'worker_noop_pattern',
      severity: 'warn',
      message: `worker ran but landed 0 commits in ${recentNoops.length} of the last few iterations (iters ${recentNoops.map((it) => it.iter).join(', ')})`,
      iters: recentNoops.map((it) => it.iter),
      recommendation: 'read those iterations\' worker-transcript.md for refusal patterns ("I am declining", "Per the system reminder"); if recurring, consider a manual evolve targeting `skills/work/SKILL.md` or src/worker.ts',
    });
  }

  // Rule 7: stagnation despite commits — outstanding stable AND commits landing.
  const tail = summary.iterations.slice(-4);
  if (tail.length === 4 && tail.every((it) => it.commitsLanded > 0)) {
    const counts = tail.map((it) => it.judgeOutstandingCount).filter((c): c is number => c !== undefined);
    if (counts.length === 4) {
      const first = counts[0];
      const stable = counts.every((c) => Math.abs(c - first) <= 1);
      if (stable && first >= 5) {
        anomalies.push({
          rule: 'stagnation_with_progress',
          severity: 'warn',
          message: `outstanding count has held steady at ~${first} for 4 iterations even though the worker is landing commits — judge may be flagging items the worker isn't actually fixing`,
          iters: tail.map((it) => it.iter),
          recommendation: 'compare the latest verdict bullets against the diff in `.autopilot/iterations/<latest>/diff.patch` — does the worker actually touch the flagged areas?',
        });
      }
    }
  }

  // Rule 8: relaunch storm — many process restarts.
  if (summary.processStarts.length >= 5) {
    anomalies.push({
      rule: 'relaunch_storm',
      severity: 'info',
      message: `autopilot has re-execed ${summary.processStarts.length} times this run (initial + ${summary.processStarts.length - 1} relaunches)`,
      recommendation: 'normal if many evolves fired; suspicious if interleaved with SDK errors — cross-reference with state.errors',
    });
  }

  // Health verdict — derived from finalState + liveness + critical anomalies.
  const health: Health = (() => {
    if (summary.finalState === 'done') return 'SHIPPED';
    if (summary.finalState === 'max_iterations') return 'STUCK';
    if (summary.finalState === 'stagnant') return 'STUCK';
    if (liveness === 'stopped' && summary.finalState === 'running') return 'CRASHED';
    if (liveness === 'stale') return 'STUCK';
    if (anomalies.some((a) => a.severity === 'critical')) return 'STUCK';
    if (anomalies.filter((a) => a.severity === 'warn').length >= 3) return 'SLOWING';
    return 'HEALTHY';
  })();

  return {
    health,
    liveness,
    pid,
    pidAlive,
    lastEventTs,
    secondsSinceLastEvent,
    stopReason: status.stopReason,
    finalState: summary.finalState,
    anomalies,
    summary,
  };
}

function renderTerminal(r: DiagnoseResult): string {
  const lines: string[] = [];
  const healthColor =
    r.health === 'SHIPPED' ? kleur.green :
    r.health === 'HEALTHY' ? kleur.cyan :
    r.health === 'SLOWING' ? kleur.yellow :
    r.health === 'STUCK' ? kleur.red :
    kleur.red;
  const livenessColor =
    r.liveness === 'running' ? kleur.cyan :
    r.liveness === 'stopped' ? kleur.gray :
    kleur.red;

  lines.push('');
  lines.push(kleur.bold().cyan('═══ autopilot diagnose ═══'));
  lines.push(`  repo:           ${r.summary.repo}`);
  lines.push(`  health:         ${kleur.bold(healthColor(r.health))}`);
  lines.push(`  liveness:       ${livenessColor(r.liveness)}${r.pid ? `  pid=${r.pid}${r.pidAlive ? ' (alive)' : ' (dead)'}` : ''}`);
  if (r.lastEventTs) {
    lines.push(`  last event:     ${r.lastEventTs.replace('T', ' ').slice(0, 19)}  (${r.secondsSinceLastEvent}s ago)`);
  }
  if (r.finalState && r.finalState !== 'running') {
    lines.push(`  final state:    ${r.finalState}`);
  }
  const lastIter = r.summary.iterations[r.summary.iterations.length - 1]?.iter ?? 0;
  lines.push(`  iterations:     ${lastIter}`);
  lines.push(`  commits:        ${r.summary.totalCommits} to target`);
  lines.push(`  refinements:    ${r.summary.refinementsUsed}`);
  lines.push(`  eval overrules: ${r.summary.evalOverrules}`);
  lines.push(`  process starts: ${r.summary.processStarts.length}`);

  lines.push('');
  if (r.anomalies.length === 0) {
    lines.push(kleur.bold().green('No anomalies detected.'));
  } else {
    lines.push(kleur.bold('Anomalies (' + r.anomalies.length + '):'));
    for (const a of r.anomalies) {
      const sevColor =
        a.severity === 'critical' ? kleur.red :
        a.severity === 'warn' ? kleur.yellow :
        kleur.dim;
      const tag = sevColor(`[${a.severity.toUpperCase()}]`);
      lines.push('');
      lines.push(`  ${tag} ${kleur.bold(a.rule)}`);
      for (const wrapped of wrap(a.message, 78, '    ')) lines.push(wrapped);
      if (a.iters && a.iters.length > 0) {
        lines.push(kleur.dim(`    iters: ${a.iters.join(', ')}`));
      }
      if (a.recommendation) {
        lines.push(kleur.dim('    →  ' + a.recommendation));
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = process not found; EPERM = exists but we don't have permission.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function humanDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = indent;
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).length > width && line.length > indent.length) {
      out.push(line);
      line = indent + word;
    } else {
      line += (line === indent ? '' : ' ') + word;
    }
  }
  if (line.trim()) out.push(line);
  return out;
}

// Test-only access.
export const __test__ = { diagnose, renderTerminal, isPidAlive };

// Used for tests that want to inject custom IterationSummary lists into
// rule logic without spinning up a fixture filesystem.
export type { IterationSummary };
