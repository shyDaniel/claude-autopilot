import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__ } from '../src/commands/diagnose.js';

const { diagnose, isPidAlive } = __test__;

interface RawEvent {
  ts: string;
  iter: number;
  phase: string;
  kind: string;
  msg?: string;
  data?: Record<string, unknown>;
}

function ts(offsetSec: number, base = '2026-04-29T17:00:00.000Z'): string {
  const d = new Date(new Date(base).getTime() + offsetSec * 1000);
  return d.toISOString();
}

function startEvt(t: string, pid: number, resume: boolean, refinementsSoFar: number): RawEvent {
  return {
    ts: t,
    iter: 0,
    phase: 'loop',
    kind: 'start',
    msg: `autopilot pid=${pid}`,
    data: {
      resume,
      refinementsSoFar,
      workerModels: { primary: 'claude-opus-4-7' },
      judgeModels: { primary: 'claude-opus-4-7' },
      maxRefinements: 5,
    },
  };
}

function setupRepo(events: RawEvent[], status: object, state: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-test-'));
  const apdir = join(dir, '.autopilot');
  mkdirSync(apdir, { recursive: true });
  writeFileSync(join(apdir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  writeFileSync(join(apdir, 'status.json'), JSON.stringify(status), 'utf8');
  writeFileSync(join(apdir, 'state.json'), JSON.stringify(state), 'utf8');
  return dir;
}

describe('diagnose: liveness + health classification', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('SHIPPED when loop ended with done', () => {
    const events: RawEvent[] = [
      startEvt(ts(0), 100, false, 0),
      { ts: ts(60), iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: true, outstanding: [] } } },
      { ts: ts(70), iter: 1, phase: 'eval', kind: 'verdict', data: { verdict: { passed: true, blockers: [] } } },
      { ts: ts(80), iter: 1, phase: 'loop', kind: 'end', msg: 'done' },
    ];
    dir = setupRepo(events, { pid: 999999999 /* not alive */ }, { errors: [] });
    const r = diagnose(dir);
    expect(r.health).toBe('SHIPPED');
    expect(r.liveness).toBe('stopped');
  });

  it('CRASHED when finalState=running but pid not alive', () => {
    const events: RawEvent[] = [
      startEvt(ts(0), 100, false, 0),
      { ts: ts(60), iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['x'] } } },
    ];
    dir = setupRepo(events, { pid: 999999999 }, { errors: [] });
    const r = diagnose(dir);
    expect(r.health).toBe('CRASHED');
    expect(r.liveness).toBe('stopped');
  });

  it('STUCK + stale when pid alive but no events for > 5 min', () => {
    const longAgo = new Date(Date.now() - 600_000).toISOString();
    const events: RawEvent[] = [
      { ts: longAgo, iter: 0, phase: 'loop', kind: 'start', msg: `autopilot pid=${process.pid}`, data: { resume: false, refinementsSoFar: 0, workerModels: { primary: 'x' }, judgeModels: { primary: 'x' }, maxRefinements: 5 } },
      { ts: longAgo, iter: 1, phase: 'judge', kind: 'start' },
    ];
    dir = setupRepo(events, { pid: process.pid }, { errors: [] });
    const r = diagnose(dir);
    expect(r.liveness).toBe('stale');
    expect(r.health).toBe('STUCK');
    expect(r.anomalies.find((a) => a.rule === 'stale_process')).toBeDefined();
  });

  it('HEALTHY when alive + recent events + no anomalies', () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    const events: RawEvent[] = [
      { ts: recent, iter: 0, phase: 'loop', kind: 'start', msg: `autopilot pid=${process.pid}`, data: { resume: false, refinementsSoFar: 0, workerModels: { primary: 'x' }, judgeModels: { primary: 'x' }, maxRefinements: 5 } },
      { ts: recent, iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['x'] } } },
      { ts: recent, iter: 1, phase: 'loop', kind: 'commit', msg: '+1 commit' },
    ];
    dir = setupRepo(events, { pid: process.pid }, { errors: [] });
    const r = diagnose(dir);
    expect(r.liveness).toBe('running');
    expect(r.health).toBe('HEALTHY');
    expect(r.anomalies.length).toBe(0);
  });
});

describe('diagnose: rules', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('judge_unparseable_rate fires when > 15% of last 10 iters lack a verdict', () => {
    const events: RawEvent[] = [startEvt(ts(0), 100, false, 0)];
    // 10 iterations: 7 with parseable verdict, 3 without (30%) — fires.
    for (let i = 1; i <= 10; i++) {
      events.push({ ts: ts(i * 60), iter: i, phase: 'loop', kind: 'start' });
      if (i <= 7) {
        events.push({ ts: ts(i * 60 + 10), iter: i, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['a'] } } });
      }
      events.push({ ts: ts(i * 60 + 50), iter: i, phase: 'loop', kind: 'end' });
    }
    dir = setupRepo(events, { pid: 999999999 }, { errors: [] });
    const r = diagnose(dir);
    const a = r.anomalies.find((x) => x.rule === 'judge_unparseable_rate');
    expect(a).toBeDefined();
    expect(a?.iters?.length).toBe(3);
  });

  it('iter_time_outlier fires on iters > 3× median', () => {
    const events: RawEvent[] = [startEvt(ts(0), 100, false, 0)];
    // 4 short iters (5min) + 1 long iter (50min). Median 5min, threshold = max(15min, 30min) = 30min. 50min trips it.
    for (let i = 1; i <= 4; i++) {
      events.push({ ts: ts(i * 60), iter: i, phase: 'loop', kind: 'start' });
      events.push({ ts: ts(i * 60 + 10), iter: i, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['a'] } } });
      events.push({ ts: ts(i * 60 + 5 * 60), iter: i, phase: 'loop', kind: 'end' });
    }
    events.push({ ts: ts(5 * 60), iter: 5, phase: 'loop', kind: 'start' });
    events.push({ ts: ts(5 * 60 + 10), iter: 5, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['a'] } } });
    events.push({ ts: ts(5 * 60 + 50 * 60), iter: 5, phase: 'loop', kind: 'end' });
    dir = setupRepo(events, { pid: 999999999 }, { errors: [] });
    const r = diagnose(dir);
    expect(r.anomalies.find((a) => a.rule === 'iter_time_outlier')).toBeDefined();
  });

  it('sdk_error_cluster fires on ≥ 3 SDK exits in the last hour', () => {
    const events: RawEvent[] = [startEvt(ts(0), 100, false, 0)];
    const now = new Date().toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    dir = setupRepo(events, { pid: 999999999 }, {
      errors: [
        { at: now, message: 'judge: Claude Code process exited with code 1' },
        { at: fiveMinAgo, message: 'judge: Claude Code process exited with code 1' },
        { at: tenMinAgo, message: 'worker: Claude Code process exited with code 1' },
      ],
    });
    const r = diagnose(dir);
    expect(r.anomalies.find((a) => a.rule === 'sdk_error_cluster')).toBeDefined();
  });

  it('evolve_storm fires when 3+ refinements happen within 30 min', () => {
    const base = '2026-04-29T08:00:00.000Z';
    const events: RawEvent[] = [
      startEvt(base, 100, false, 0),
      { ts: ts(60, base), iter: 5, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'evolve', reason: 'rapid' } } },
      { ts: ts(120, base), iter: 0, phase: 'loop', kind: 'commit', msg: 'refinement#1: aaa → bbb', data: { preHeadSha: 'aaa', postHeadSha: 'bbb' } },
      { ts: ts(180, base), iter: 6, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'evolve', reason: 'still' } } },
      { ts: ts(240, base), iter: 0, phase: 'loop', kind: 'commit', msg: 'refinement#2: bbb → ccc', data: { preHeadSha: 'bbb', postHeadSha: 'ccc' } },
      { ts: ts(300, base), iter: 7, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'evolve', reason: 'still' } } },
      { ts: ts(360, base), iter: 0, phase: 'loop', kind: 'commit', msg: 'refinement#3: ccc → ddd', data: { preHeadSha: 'ccc', postHeadSha: 'ddd' } },
    ];
    dir = setupRepo(events, { pid: 999999999 }, { errors: [] });
    const r = diagnose(dir);
    const a = r.anomalies.find((x) => x.rule === 'evolve_storm');
    expect(a).toBeDefined();
    expect(a?.iters).toEqual([5, 6, 7]);
  });

  it('worker_noop_pattern fires on 2+ recent iters with worker tools but 0 commits', () => {
    const events: RawEvent[] = [startEvt(ts(0), 100, false, 0)];
    for (let i = 1; i <= 3; i++) {
      events.push({ ts: ts(i * 60), iter: i, phase: 'loop', kind: 'start' });
      events.push({ ts: ts(i * 60 + 10), iter: i, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['x'] } } });
      events.push({ ts: ts(i * 60 + 20), iter: i, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'work', reason: '...' } } });
      events.push({ ts: ts(i * 60 + 30), iter: i, phase: 'worker', kind: 'start' });
      events.push({ ts: ts(i * 60 + 35), iter: i, phase: 'worker', kind: 'tool', msg: 'Read' });
      events.push({ ts: ts(i * 60 + 50), iter: i, phase: 'loop', kind: 'end' });
      // No commit event — worker ran but landed nothing.
    }
    dir = setupRepo(events, { pid: 999999999 }, { errors: [] });
    const r = diagnose(dir);
    expect(r.anomalies.find((a) => a.rule === 'worker_noop_pattern')).toBeDefined();
  });

  it('relaunch_storm fires on ≥ 5 process starts', () => {
    const events: RawEvent[] = [
      startEvt(ts(0), 100, false, 0),
      startEvt(ts(60), 200, true, 1),
      startEvt(ts(120), 300, true, 2),
      startEvt(ts(180), 400, true, 3),
      startEvt(ts(240), 500, true, 4),
    ];
    dir = setupRepo(events, { pid: 999999999 }, { errors: [] });
    const r = diagnose(dir);
    expect(r.anomalies.find((a) => a.rule === 'relaunch_storm')).toBeDefined();
  });

  it('SLOWING when 3+ warn-severity anomalies fire', () => {
    // Build a run that trips judge_unparseable_rate, sdk_error_cluster, worker_noop_pattern.
    // Use process.pid + recent timestamps so the run reads as `liveness=running`
    // — otherwise the CRASHED rule pre-empts SLOWING.
    const recent = (offsetSec: number) => new Date(Date.now() - offsetSec * 1000).toISOString();
    const events: RawEvent[] = [
      { ts: recent(700), iter: 0, phase: 'loop', kind: 'start', msg: `autopilot pid=${process.pid}`, data: { resume: false, refinementsSoFar: 0, workerModels: { primary: 'x' }, judgeModels: { primary: 'x' }, maxRefinements: 5 } },
    ];
    for (let i = 1; i <= 10; i++) {
      const base = 700 - i * 60;
      events.push({ ts: recent(base), iter: i, phase: 'loop', kind: 'start' });
      // Half lack verdicts.
      if (i % 2 === 0) {
        events.push({ ts: recent(base - 10), iter: i, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['x'] } } });
      }
      events.push({ ts: recent(base - 20), iter: i, phase: 'worker', kind: 'start' });
      events.push({ ts: recent(base - 25), iter: i, phase: 'worker', kind: 'tool', msg: 'Read' });
      events.push({ ts: recent(base - 50), iter: i, phase: 'loop', kind: 'end' });
    }
    const now = new Date().toISOString();
    dir = setupRepo(events, { pid: process.pid }, {
      errors: [
        { at: now, message: 'judge: Claude Code process exited with code 1' },
        { at: now, message: 'judge: Claude Code process exited with code 1' },
        { at: now, message: 'worker: Claude Code process exited with code 1' },
      ],
    });
    const r = diagnose(dir);
    const warnCount = r.anomalies.filter((a) => a.severity === 'warn').length;
    expect(warnCount).toBeGreaterThanOrEqual(3);
    expect(r.health).toBe('SLOWING');
  });
});

describe('isPidAlive', () => {
  it('returns true for own pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for clearly-dead pid', () => {
    expect(isPidAlive(999999999)).toBe(false);
  });
});

describe('diagnose: refuses on missing events.jsonl', () => {
  it('builds a result with running state and no iterations when events file is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-empty-'));
    mkdirSync(join(dir, '.autopilot'));
    writeFileSync(join(dir, '.autopilot', 'events.jsonl'), '', 'utf8');
    writeFileSync(join(dir, '.autopilot', 'status.json'), '{}', 'utf8');
    writeFileSync(join(dir, '.autopilot', 'state.json'), '{}', 'utf8');
    try {
      const r = diagnose(dir);
      expect(r.summary.iterations.length).toBe(0);
      expect(r.anomalies.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
