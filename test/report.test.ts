import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/commands/report.js';

const { buildSummary, renderTerminal, renderMarkdown, humanDuration } = __test__;

interface Evt {
  ts: string;
  iter: number;
  phase: 'loop' | 'judge' | 'worker' | 'eval' | 'orchestrate';
  kind: string;
  msg?: string;
  data?: Record<string, unknown>;
}

function startEvt(ts: string, pid: number, resume: boolean, refinementsSoFar: number): Evt {
  return {
    ts,
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

describe('humanDuration', () => {
  it('formats sub-second', () => expect(humanDuration(523)).toBe('523ms'));
  it('formats seconds', () => expect(humanDuration(45_000)).toBe('45s'));
  it('formats minutes', () => expect(humanDuration(125_000)).toBe('2m 5s'));
  it('formats hours', () => expect(humanDuration(7_200_000)).toBe('2h 0m'));
});

describe('buildSummary', () => {
  it('returns empty-ish summary when no iterations', () => {
    const events: Evt[] = [startEvt('2026-04-29T08:00:00Z', 100, false, 0)];
    const s = buildSummary(events, '/tmp/x');
    expect(s.iterations.length).toBe(0);
    expect(s.refinements.length).toBe(0);
    expect(s.processStarts.length).toBe(1);
    expect(s.processStarts[0].resume).toBe(false);
  });

  it('isolates the most-recent fresh run from older history', () => {
    const events: Evt[] = [
      // Old run
      startEvt('2026-04-20T07:00:00Z', 1, false, 0),
      { ts: '2026-04-20T07:00:01Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['old'] } } },
      // New run
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:00:01Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['new1', 'new2'] } } },
    ];
    const s = buildSummary(events, '/tmp/x');
    expect(s.processStarts.length).toBe(1);
    expect(s.iterations.length).toBe(1);
    expect(s.iterations[0].judgeOutstandingCount).toBe(2);
  });

  it('counts process starts as relaunches', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      startEvt('2026-04-29T08:15:00Z', 200, true, 1),
      startEvt('2026-04-29T08:22:00Z', 300, true, 2),
    ];
    const s = buildSummary(events, '/tmp/x');
    expect(s.processStarts.length).toBe(3);
    expect(s.processStarts[1].resume).toBe(true);
    expect(s.processStarts[2].refinementsSoFar).toBe(2);
  });

  it('summarizes a complete iteration: judge + orchestrate + work + commits', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:01:00Z', iter: 1, phase: 'loop', kind: 'start' },
      { ts: '2026-04-29T08:01:10Z', iter: 1, phase: 'judge', kind: 'start' },
      { ts: '2026-04-29T08:02:00Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['a', 'b', 'c'] } } },
      { ts: '2026-04-29T08:02:10Z', iter: 1, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'work', reason: 'progress visible' } } },
      { ts: '2026-04-29T08:02:20Z', iter: 1, phase: 'worker', kind: 'start' },
      { ts: '2026-04-29T08:02:30Z', iter: 1, phase: 'worker', kind: 'tool', msg: 'Read' },
      { ts: '2026-04-29T08:02:40Z', iter: 1, phase: 'worker', kind: 'tool', msg: 'Edit' },
      { ts: '2026-04-29T08:05:00Z', iter: 1, phase: 'loop', kind: 'commit', msg: '+2 commits' },
      { ts: '2026-04-29T08:05:10Z', iter: 1, phase: 'loop', kind: 'end' },
    ];
    const s = buildSummary(events, '/tmp/x');
    const it = s.iterations[0];
    expect(it.judgeDone).toBe(false);
    expect(it.judgeOutstandingCount).toBe(3);
    expect(it.orchestratorRan).toBe(true);
    expect(it.orchestratorChoice).toBe('work');
    expect(it.workerRan).toBe(true);
    expect(it.workerToolCount).toBe(2);
    expect(it.commitsLanded).toBe(2);
    expect(s.totalCommits).toBe(2);
  });

  it('detects eval-overruled-judge case', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:01:00Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: true, outstanding: [] } } },
      {
        ts: '2026-04-29T08:02:00Z',
        iter: 1,
        phase: 'eval',
        kind: 'verdict',
        data: { verdict: { passed: false, blockers: ['x', 'y'] } },
      },
      { ts: '2026-04-29T08:02:10Z', iter: 1, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'work', reason: 'eval overrode' } } },
    ];
    const s = buildSummary(events, '/tmp/x');
    expect(s.iterations[0].judgeDone).toBe(true);
    expect(s.iterations[0].evalRan).toBe(true);
    expect(s.iterations[0].evalPassed).toBe(false);
    expect(s.iterations[0].evalBlockerCount).toBe(2);
    expect(s.evalOverrules).toBe(1);
  });

  it('captures refinement events with pre/post HEAD and trigger reason', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:01:00Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['x'] } } },
      {
        ts: '2026-04-29T08:01:30Z',
        iter: 1,
        phase: 'orchestrate',
        kind: 'verdict',
        data: { verdict: { next_skill: 'evolve', reason: 'worker spinning on refusal' } },
      },
      {
        ts: '2026-04-29T08:05:00Z',
        iter: 0,
        phase: 'loop',
        kind: 'commit',
        msg: 'refinement#1: aaa1111 → bbb2222',
        data: { preHeadSha: 'aaa1111', postHeadSha: 'bbb2222', transcriptPath: '/tmp/r1.md' },
      },
    ];
    const s = buildSummary(events, '/tmp/x');
    expect(s.refinements.length).toBe(1);
    expect(s.refinements[0].preHeadSha).toBe('aaa1111');
    expect(s.refinements[0].postHeadSha).toBe('bbb2222');
    expect(s.refinements[0].iter).toBe(1);
    expect(s.refinements[0].triggerReason).toBe('worker spinning on refusal');
    expect(s.refinementsUsed).toBe(1);
  });

  it('captures model fallback events per iteration', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      {
        ts: '2026-04-29T08:01:00Z',
        iter: 1,
        phase: 'worker',
        kind: 'error',
        msg: 'fallback claude-opus-4-7 → claude-sonnet-4-6',
        data: { from: 'claude-opus-4-7', to: 'claude-sonnet-4-6' },
      },
    ];
    const s = buildSummary(events, '/tmp/x');
    expect(s.iterations[0].fallbackEvents.length).toBe(1);
    expect(s.iterations[0].fallbackEvents[0].from).toBe('claude-opus-4-7');
    expect(s.iterations[0].fallbackEvents[0].to).toBe('claude-sonnet-4-6');
  });

  it('marks final state = done on loop-end-done event', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:05:00Z', iter: 1, phase: 'loop', kind: 'end', msg: 'done' },
    ];
    const s = buildSummary(events, '/tmp/x');
    expect(s.finalState).toBe('done');
  });
});

describe('renderTerminal', () => {
  it('renders header + iteration row + refinement detail', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:01:00Z', iter: 1, phase: 'loop', kind: 'start' },
      { ts: '2026-04-29T08:01:10Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['x'] } } },
      { ts: '2026-04-29T08:01:20Z', iter: 1, phase: 'orchestrate', kind: 'verdict', data: { verdict: { next_skill: 'work', reason: 'fine' } } },
      { ts: '2026-04-29T08:01:30Z', iter: 1, phase: 'worker', kind: 'start' },
      { ts: '2026-04-29T08:02:00Z', iter: 1, phase: 'loop', kind: 'commit', msg: '+1 commits' },
      { ts: '2026-04-29T08:02:10Z', iter: 1, phase: 'loop', kind: 'end', msg: 'done' },
    ];
    const s = buildSummary(events, '/repo/x');
    const out = renderTerminal(s);
    expect(out).toContain('autopilot run report');
    expect(out).toContain('/repo/x');
    expect(out).toContain('SHIPPED');
    expect(out).toContain('iter  1');
    expect(out).toContain('initial launch');
  });
});

describe('renderMarkdown', () => {
  it('emits markdown table rows for iterations', () => {
    const events: Evt[] = [
      startEvt('2026-04-29T08:00:00Z', 100, false, 0),
      { ts: '2026-04-29T08:01:00Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: true, outstanding: [] } } },
      { ts: '2026-04-29T08:02:00Z', iter: 1, phase: 'eval', kind: 'verdict', data: { verdict: { passed: true, blockers: [] } } },
      { ts: '2026-04-29T08:02:10Z', iter: 1, phase: 'loop', kind: 'end', msg: 'done' },
    ];
    const s = buildSummary(events, '/repo/x');
    const md = renderMarkdown(s);
    expect(md).toContain('# Autopilot run report');
    expect(md).toContain('| Iter |');
    expect(md).toContain('| 1 |');
    expect(md).toContain('✓ passed');
  });
});
