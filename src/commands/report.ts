import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { join, resolve } from 'node:path';
import kleur from 'kleur';
import { log } from '../logging.js';

export interface RawEvent {
  ts: string;
  iter: number;
  phase: 'loop' | 'judge' | 'worker' | 'eval' | 'orchestrate';
  kind: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface IterationSummary {
  iter: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  judgeDone?: boolean;
  judgeOutstandingCount?: number;
  evalRan: boolean;
  evalPassed?: boolean;
  evalBlockerCount?: number;
  orchestratorRan: boolean;
  orchestratorChoice?: string;
  orchestratorReason?: string;
  workerRan: boolean;
  commitsLanded: number;
  fallbackEvents: { phase: string; from: string; to: string }[];
  workerToolCount: number;
  evolveTriggered: boolean;
  endMsg?: string;
}

export interface RefinementSummary {
  number: number;
  iter: number;
  ts: string;
  preHeadSha: string;
  postHeadSha: string;
  transcriptPath?: string;
  triggerReason?: string;
}

export interface ProcessStart {
  ts: string;
  pid: string | number;
  resume: boolean;
  refinementsSoFar: number;
}

export interface RunSummary {
  repo: string;
  startedAt: string;
  endedAt?: string;
  iterations: IterationSummary[];
  refinements: RefinementSummary[];
  processStarts: ProcessStart[];
  finalState?: 'done' | 'stagnant' | 'max_iterations' | 'error' | 'interrupted' | 'running';
  finalMessage?: string;
  workerModel: string;
  judgeModel: string;
  totalCommits: number;
  evolveBudget: number;
  refinementsUsed: number;
  evalOverrules: number;
}

export interface ReportOptions {
  json?: boolean;
  markdown?: boolean;
  live?: boolean;
}

export async function reportCommand(repo: string, opts: ReportOptions): Promise<number> {
  const repoAbs = resolve(repo);
  const eventsPath = join(repoAbs, '.autopilot', 'events.jsonl');
  if (!existsSync(eventsPath)) {
    log.err(`no autopilot events at ${eventsPath} — has autopilot ever run on this repo?`);
    return 1;
  }

  const render = (): void => {
    const events = readEvents(eventsPath);
    const summary = buildSummary(events, repoAbs);
    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    } else if (opts.markdown) {
      process.stdout.write(renderMarkdown(summary) + '\n');
    } else {
      process.stdout.write(renderTerminal(summary) + '\n');
    }
  };

  render();

  if (opts.live) {
    log.info('--live: watching events.jsonl for new entries (Ctrl-C to exit)');
    let lastSize = statSync(eventsPath).size;
    const onChange = (): void => {
      const size = statSync(eventsPath).size;
      if (size === lastSize) return;
      lastSize = size;
      // Clear screen + reprint.
      process.stdout.write('\x1b[2J\x1b[H');
      render();
    };
    watchFile(eventsPath, { interval: 2000 }, onChange);
    await new Promise<void>((r) => process.on('SIGINT', () => { unwatchFile(eventsPath); r(); }));
  }
  return 0;
}

export function readEvents(path: string): RawEvent[] {
  const raw = readFileSync(path, 'utf8');
  const out: RawEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawEvent);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function buildSummary(events: RawEvent[], repo: string): RunSummary {
  // Find the last "loop start" event without resume to delimit "this run".
  // This avoids merging output from old historical runs into the report.
  const starts = events.filter(
    (e) => e.phase === 'loop' && e.kind === 'start' && typeof e.msg === 'string' && e.msg.startsWith('autopilot pid='),
  );
  const lastFreshStartIdx = (() => {
    for (let i = starts.length - 1; i >= 0; i--) {
      if ((starts[i].data as { resume?: boolean } | undefined)?.resume === false) return i;
    }
    return 0;
  })();
  const cutStart = starts[lastFreshStartIdx];
  const cutTs = cutStart?.ts ?? events[0]?.ts ?? new Date().toISOString();
  const runEvents = events.filter((e) => e.ts >= cutTs);

  // Process starts within this run = initial + each relaunch.
  const processStarts: ProcessStart[] = runEvents
    .filter((e) => e.phase === 'loop' && e.kind === 'start' && typeof e.msg === 'string' && e.msg.startsWith('autopilot pid='))
    .map((e) => ({
      ts: e.ts,
      pid: (e.msg ?? '').replace('autopilot pid=', '').trim(),
      resume: ((e.data as { resume?: boolean } | undefined)?.resume) ?? false,
      refinementsSoFar: ((e.data as { refinementsSoFar?: number } | undefined)?.refinementsSoFar) ?? 0,
    }));

  const workerModel =
    ((cutStart?.data as { workerModels?: { primary?: string } } | undefined)?.workerModels?.primary) ?? '?';
  const judgeModel =
    ((cutStart?.data as { judgeModels?: { primary?: string } } | undefined)?.judgeModels?.primary) ?? '?';
  const evolveBudget =
    ((cutStart?.data as { maxRefinements?: number } | undefined)?.maxRefinements) ?? 0;

  // Group events by iter; iter=0 events are loop-level (start/end of process).
  const iters = new Map<number, RawEvent[]>();
  for (const e of runEvents) {
    if (e.iter <= 0) continue;
    const arr = iters.get(e.iter) ?? [];
    arr.push(e);
    iters.set(e.iter, arr);
  }

  const iterations: IterationSummary[] = [];
  const sortedIters = [...iters.keys()].sort((a, b) => a - b);
  for (const n of sortedIters) {
    const arr = iters.get(n) ?? [];
    iterations.push(summarizeIter(n, arr));
  }

  // Refinement events are at iter=0 (loop-level); collect them.
  const refinements: RefinementSummary[] = runEvents
    .filter((e) => e.iter === 0 && e.kind === 'commit' && typeof e.msg === 'string' && e.msg.startsWith('refinement#'))
    .map((e, i) => {
      const d = (e.data ?? {}) as { preHeadSha?: string; postHeadSha?: string; transcriptPath?: string };
      return {
        number: i + 1,
        iter: findRefinementIter(runEvents, e.ts),
        ts: e.ts,
        preHeadSha: d.preHeadSha ?? '',
        postHeadSha: d.postHeadSha ?? '',
        transcriptPath: d.transcriptPath,
        triggerReason: findOrchestratorEvolveReason(runEvents, e.ts),
      };
    });

  const finalEnd = [...runEvents].reverse().find(
    (e) => e.phase === 'loop' && e.kind === 'end' && (e.msg === 'done' || e.msg === 'max_iterations' || e.msg?.includes('stuck') || e.msg?.startsWith('orchestrator')),
  );
  let finalState: RunSummary['finalState'] = 'running';
  if (finalEnd) {
    if (finalEnd.msg === 'done') finalState = 'done';
    else if (finalEnd.msg === 'max_iterations') finalState = 'max_iterations';
    else if (finalEnd.msg?.includes('stuck')) finalState = 'stagnant';
    else finalState = 'stagnant';
  }

  const totalCommits = iterations.reduce((sum, it) => sum + it.commitsLanded, 0);
  const evalOverrules = iterations.filter((it) => it.evalRan && it.evalPassed === false).length;

  return {
    repo,
    startedAt: cutStart?.ts ?? '',
    endedAt: finalEnd?.ts,
    iterations,
    refinements,
    processStarts,
    finalState,
    finalMessage: finalEnd?.msg,
    workerModel,
    judgeModel,
    totalCommits,
    evolveBudget,
    refinementsUsed: refinements.length,
    evalOverrules,
  };
}

function summarizeIter(iter: number, arr: RawEvent[]): IterationSummary {
  const sorted = [...arr].sort((a, b) => a.ts.localeCompare(b.ts));
  const firstStart = sorted.find((e) => e.phase === 'loop' && e.kind === 'start');
  const lastEnd = [...sorted].reverse().find((e) => e.phase === 'loop' && e.kind === 'end');
  const judgeVerdict = sorted.find((e) => e.phase === 'judge' && e.kind === 'verdict');
  const evalVerdict = sorted.find((e) => e.phase === 'eval' && e.kind === 'verdict');
  const orchestratorVerdict = sorted.find((e) => e.phase === 'orchestrate' && e.kind === 'verdict');
  const workerEvents = sorted.filter((e) => e.phase === 'worker');
  const commitEvents = sorted.filter((e) => e.phase === 'loop' && e.kind === 'commit');
  const fallbackEvents = sorted.filter((e) => e.kind === 'error' && typeof e.msg === 'string' && e.msg.startsWith('fallback '));

  const jdata = (judgeVerdict?.data as { verdict?: { done?: boolean; outstanding?: unknown[] } } | undefined)?.verdict;
  const edata = (evalVerdict?.data as { verdict?: { passed?: boolean; blockers?: unknown[] } } | undefined)?.verdict;
  const odata = (orchestratorVerdict?.data as { verdict?: { next_skill?: string; reason?: string } } | undefined)?.verdict;

  let commits = 0;
  for (const c of commitEvents) {
    const m = (c.msg ?? '').match(/^\+(\d+)\s+commit/);
    if (m) commits += parseInt(m[1], 10);
    else if (typeof c.msg === 'string' && c.msg.startsWith('refinement#')) {
      // Refinement commits are tracked separately in refinements[].
      // Don't double-count them as worker commits.
    }
  }

  const startTs = firstStart?.ts ?? sorted[0]?.ts;
  const endTs = lastEnd?.ts ?? sorted[sorted.length - 1]?.ts;
  const durationMs = startTs && endTs ? new Date(endTs).getTime() - new Date(startTs).getTime() : undefined;

  return {
    iter,
    startedAt: startTs,
    endedAt: endTs,
    durationMs,
    judgeDone: jdata?.done,
    judgeOutstandingCount: jdata?.outstanding ? jdata.outstanding.length : undefined,
    evalRan: !!evalVerdict,
    evalPassed: edata?.passed,
    evalBlockerCount: edata?.blockers ? edata.blockers.length : undefined,
    orchestratorRan: !!orchestratorVerdict,
    orchestratorChoice: odata?.next_skill,
    orchestratorReason: odata?.reason,
    workerRan: workerEvents.some((e) => e.kind === 'start'),
    commitsLanded: commits,
    fallbackEvents: fallbackEvents.map((e) => {
      const d = (e.data ?? {}) as { from?: string; to?: string };
      return { phase: e.phase, from: d.from ?? '?', to: d.to ?? '?' };
    }),
    workerToolCount: workerEvents.filter((e) => e.kind === 'tool').length,
    evolveTriggered: odata?.next_skill === 'evolve',
    endMsg: lastEnd?.msg,
  };
}

function findRefinementIter(events: RawEvent[], ts: string): number {
  // The closest preceding orchestrate verdict with next_skill=evolve points to
  // the iter that triggered this refinement. Fall back to the loop-level
  // refinement-start event's iter if not found.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].ts > ts) continue;
    if (events[i].phase === 'orchestrate' && events[i].kind === 'verdict') {
      const v = (events[i].data as { verdict?: { next_skill?: string } } | undefined)?.verdict;
      if (v?.next_skill === 'evolve') return events[i].iter;
    }
  }
  return 0;
}

function findOrchestratorEvolveReason(events: RawEvent[], ts: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].ts > ts) continue;
    if (events[i].phase === 'orchestrate' && events[i].kind === 'verdict') {
      const v = (events[i].data as { verdict?: { next_skill?: string; reason?: string } } | undefined)?.verdict;
      if (v?.next_skill === 'evolve') return v.reason;
    }
  }
  return undefined;
}

function renderTerminal(s: RunSummary): string {
  const lines: string[] = [];
  const totalDuration = s.endedAt && s.startedAt
    ? humanDuration(new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime())
    : '(running)';
  const lastIter = s.iterations[s.iterations.length - 1]?.iter ?? 0;
  const stateStr =
    s.finalState === 'done'
      ? kleur.green('SHIPPED ✓')
      : s.finalState === 'running'
        ? kleur.cyan('running…')
        : kleur.yellow(`stopped: ${s.finalState}`);

  lines.push('');
  lines.push(kleur.bold().cyan('═══ autopilot run report ═══'));
  lines.push(`  repo:         ${s.repo}`);
  lines.push(`  started:      ${s.startedAt.replace('T', ' ').slice(0, 19)}`);
  lines.push(`  duration:     ${totalDuration}`);
  lines.push(`  iterations:   ${lastIter}`);
  lines.push(`  state:        ${stateStr}`);
  lines.push(`  commits:      ${s.totalCommits} to target`);
  lines.push(
    `  refinements:  ${s.refinementsUsed}${Number.isFinite(s.evolveBudget) && s.evolveBudget > 0 ? ` / ${s.evolveBudget} budget` : ' (uncapped)'} (autopilot self-evolved)`,
  );
  lines.push(`  eval overrules: ${s.evalOverrules}  (judge said done; eval said no)`);
  lines.push(`  models:       worker=${s.workerModel}  judge=${s.judgeModel}`);
  lines.push(`  process starts (each = relaunch): ${s.processStarts.length}`);

  // Process timeline
  lines.push('');
  lines.push(kleur.bold('Process lifecycle (relaunches):'));
  for (const p of s.processStarts) {
    const tag = p.resume ? kleur.cyan(`relaunch (refinement #${p.refinementsSoFar})`) : kleur.gray('initial launch');
    lines.push(`  ${p.ts.replace('T', ' ').slice(0, 19)}  pid=${String(p.pid).padEnd(8)}  ${tag}`);
  }

  // Iteration grid
  lines.push('');
  lines.push(kleur.bold('Per-iteration timeline:'));
  lines.push(kleur.dim(`  ●judge  ◇orch  ◆eval  ▲work  ⚡evolve  ↻relaunch  ✚commit`));
  lines.push('');

  for (const it of s.iterations) {
    const phases: string[] = [];
    if (it.judgeDone !== undefined) {
      phases.push(it.judgeDone ? kleur.green('●j(done?)') : kleur.cyan('●j'));
    } else {
      phases.push(kleur.gray('●j(?)'));
    }
    if (it.evalRan) {
      phases.push(it.evalPassed ? kleur.green('◆e✓') : kleur.red(`◆e✗(${it.evalBlockerCount ?? '?'})`));
    }
    if (it.orchestratorRan) {
      const colorize =
        it.orchestratorChoice === 'evolve'
          ? kleur.magenta
          : it.orchestratorChoice === 'work'
            ? kleur.cyan
            : it.orchestratorChoice === 'reframe'
              ? kleur.yellow
              : kleur.red;
      phases.push(colorize(`◇o→${it.orchestratorChoice ?? '?'}`));
    }
    if (it.workerRan) {
      phases.push(kleur.cyan(`▲w(${it.workerToolCount} tools)`));
    }
    if (it.evolveTriggered) {
      phases.push(kleur.magenta('⚡evolve'));
      phases.push(kleur.magenta('↻relaunch'));
    }
    if (it.commitsLanded > 0) {
      phases.push(kleur.green(`✚${it.commitsLanded}`));
    }
    if (it.fallbackEvents.length) {
      phases.push(kleur.yellow(`⚠fallback×${it.fallbackEvents.length}`));
    }
    const dur = it.durationMs !== undefined ? humanDuration(it.durationMs) : '?';
    const evalNote =
      it.evalRan && it.evalPassed === false
        ? kleur.red('  EVAL OVERRULED JUDGE')
        : '';
    lines.push(`  iter ${String(it.iter).padStart(2)}  ${phases.join(' → ')}  ${kleur.dim(`(${dur})`)}${evalNote}`);
  }

  // Refinements detail
  if (s.refinements.length) {
    lines.push('');
    lines.push(kleur.bold().magenta('Self-evolves (autopilot edited its own source):'));
    for (const r of s.refinements) {
      lines.push('');
      lines.push(`  ${kleur.magenta(`refinement #${r.number}`)}  triggered at iter ${r.iter}`);
      lines.push(`    when:        ${r.ts.replace('T', ' ').slice(0, 19)}`);
      lines.push(`    autopilot:   ${r.preHeadSha.slice(0, 7)} → ${r.postHeadSha.slice(0, 7)}`);
      if (r.transcriptPath) lines.push(`    transcript:  ${r.transcriptPath}`);
      if (r.triggerReason) {
        const reasonLines = wrapLines(r.triggerReason, 70, '      ');
        lines.push(`    reason:      ${reasonLines[0].trim()}`);
        for (const l of reasonLines.slice(1)) lines.push(l);
      }
    }
  }

  // Eval overrules detail
  const overrules = s.iterations.filter((it) => it.evalRan && it.evalPassed === false);
  if (overrules.length) {
    lines.push('');
    lines.push(kleur.bold().red('Eval overrules (judge said done; eval blocked):'));
    for (const it of overrules) {
      lines.push(`  iter ${it.iter}: ${it.evalBlockerCount} blocker(s)`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderMarkdown(s: RunSummary): string {
  const lines: string[] = [];
  const totalDuration = s.endedAt && s.startedAt
    ? humanDuration(new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime())
    : '(running)';
  const lastIter = s.iterations[s.iterations.length - 1]?.iter ?? 0;
  lines.push(`# Autopilot run report — \`${s.repo}\``);
  lines.push('');
  lines.push(`- **Started:** ${s.startedAt}`);
  lines.push(`- **Duration:** ${totalDuration}`);
  lines.push(`- **Iterations:** ${lastIter}`);
  lines.push(`- **State:** ${s.finalState}${s.finalMessage ? ` (${s.finalMessage})` : ''}`);
  lines.push(`- **Commits to target:** ${s.totalCommits}`);
  lines.push(
    `- **Refinements used:** ${s.refinementsUsed}${Number.isFinite(s.evolveBudget) && s.evolveBudget > 0 ? ` / ${s.evolveBudget}` : ' (uncapped)'}`,
  );
  lines.push(`- **Eval overrules:** ${s.evalOverrules}`);
  lines.push(`- **Worker model:** ${s.workerModel}`);
  lines.push(`- **Judge model:** ${s.judgeModel}`);
  lines.push('');
  lines.push('## Process lifecycle');
  lines.push('');
  lines.push('| When | PID | Kind |');
  lines.push('| --- | --- | --- |');
  for (const p of s.processStarts) {
    lines.push(`| ${p.ts} | ${p.pid} | ${p.resume ? `relaunch (refinement #${p.refinementsSoFar})` : 'initial launch'} |`);
  }
  lines.push('');
  lines.push('## Per-iteration timeline');
  lines.push('');
  lines.push('| Iter | Judge | Eval | Orch | Worker | Commits | Duration | Notes |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const it of s.iterations) {
    const judge = it.judgeDone === undefined ? '?' : it.judgeDone ? '✓ done?' : `${it.judgeOutstandingCount ?? '?'} outstanding`;
    const evalCol = !it.evalRan ? '—' : it.evalPassed ? '✓ passed' : `✗ ${it.evalBlockerCount ?? '?'} blockers`;
    const orchCol = !it.orchestratorRan ? '—' : it.orchestratorChoice ?? '?';
    const workerCol = it.workerRan ? `${it.workerToolCount} tools` : '—';
    const dur = it.durationMs !== undefined ? humanDuration(it.durationMs) : '?';
    const notes: string[] = [];
    if (it.evolveTriggered) notes.push('evolve+relaunch');
    if (it.fallbackEvents.length) notes.push(`fallback×${it.fallbackEvents.length}`);
    if (it.evalRan && it.evalPassed === false) notes.push('**eval overruled judge**');
    lines.push(
      `| ${it.iter} | ${judge} | ${evalCol} | ${orchCol} | ${workerCol} | ${it.commitsLanded} | ${dur} | ${notes.join(', ') || ''} |`,
    );
  }

  if (s.refinements.length) {
    lines.push('');
    lines.push('## Self-evolves');
    for (const r of s.refinements) {
      lines.push('');
      lines.push(`### Refinement #${r.number} (triggered at iter ${r.iter})`);
      lines.push('');
      lines.push(`- **When:** ${r.ts}`);
      lines.push(`- **Autopilot HEAD:** \`${r.preHeadSha.slice(0, 7)}\` → \`${r.postHeadSha.slice(0, 7)}\``);
      if (r.transcriptPath) lines.push(`- **Transcript:** \`${r.transcriptPath}\``);
      if (r.triggerReason) {
        lines.push(`- **Reason:**`);
        lines.push('');
        lines.push('  > ' + r.triggerReason);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function wrapLines(text: string, width: number, indent: string): string[] {
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

// Used by tests to exercise the parser without spawning a process.
export const __test__ = { buildSummary, renderTerminal, renderMarkdown, humanDuration };
