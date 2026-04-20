import { describe, it, expect } from 'vitest';
import {
  freshPlan,
  reconcilePlan,
  pickNextSubtask,
  markExhaustedAsNeedsReframe,
  collectStuckSubtasks,
  renderStuckBrief,
  planSummary,
  renderSubtaskBrief,
  MAX_REFRAME_DEPTH,
  type Plan,
} from '../src/planner.js';

describe('reconcilePlan', () => {
  it('adds new subtasks as pending on first encounter', () => {
    const plan = reconcilePlan(null, ['- Fix mirror bot ties', '- Add home animation'], undefined, 1, undefined);
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks.every((s) => s.status === 'pending' && s.attempts === 0)).toBe(true);
    expect(plan.subtasks[0].firstSeenIteration).toBe(1);
  });

  it('enriches new subtasks with structured fields when provided', () => {
    const plan = reconcilePlan(
      null,
      ['Fix mirror bot'],
      [
        {
          files: ['packages/shared/src/game/bots/mirror.ts'],
          symptom: 'copies last choice → ties vs repeating opponent',
          desired: 'break the cycle when last round was a tie',
          acceptance: '20 games vs always-ROCK → tie rate < 50%',
        },
      ],
      1,
    );
    expect(plan.subtasks[0].files).toEqual(['packages/shared/src/game/bots/mirror.ts']);
    expect(plan.subtasks[0].symptom).toContain('ties');
    expect(plan.subtasks[0].acceptance).toContain('50%');
  });

  it('bumps attempts when the lastWorkedOnId subtask is still outstanding', () => {
    const prior = reconcilePlan(null, ['- Fix mirror bot ties'], undefined, 1);
    const id = prior.subtasks[0].id;
    const next = reconcilePlan(prior, ['- Fix mirror bot ties'], undefined, 2, id);
    expect(next.subtasks[0].attempts).toBe(1);
    expect(next.subtasks[0].lastAttemptIteration).toBe(2);
  });

  it('does NOT bump attempts for subtasks the worker did not touch', () => {
    const prior = reconcilePlan(null, ['- A', '- B'], undefined, 1);
    const workedId = prior.subtasks[0].id;
    const next = reconcilePlan(prior, ['- A', '- B'], undefined, 2, workedId);
    expect(next.subtasks.find((s) => s.id === workedId)!.attempts).toBe(1);
    expect(next.subtasks.find((s) => s.text === '- B')!.attempts).toBe(0);
  });

  it('marks subtasks that vanish from outstanding as completed', () => {
    const prior = reconcilePlan(null, ['- A', '- B'], undefined, 1);
    const next = reconcilePlan(prior, ['- B'], undefined, 2);
    const a = next.subtasks.find((s) => s.text === '- A')!;
    expect(a.status).toBe('completed');
    expect(a.completedAtIteration).toBe(2);
  });

  it('preserves failed / reframed / blocked terminal markers across iterations', () => {
    const prior = reconcilePlan(null, ['- A', '- B', '- C'], undefined, 1);
    prior.subtasks[0].status = 'failed';
    prior.subtasks[0].failureReason = 'gave up';
    prior.subtasks[1].status = 'reframed';
    prior.subtasks[2].status = 'blocked';
    prior.subtasks[2].blockedReason = 'needs human';
    const next = reconcilePlan(prior, [], undefined, 2);
    expect(next.subtasks.find((s) => s.text === '- A')!.status).toBe('failed');
    expect(next.subtasks.find((s) => s.text === '- B')!.status).toBe('reframed');
    expect(next.subtasks.find((s) => s.text === '- C')!.status).toBe('blocked');
  });

  it('treats reworded-but-semantically-same bullets as the same subtask', () => {
    const prior = reconcilePlan(null, ['- Add home animation'], undefined, 1);
    const next = reconcilePlan(prior, ['1. add   home animation'], undefined, 2, prior.subtasks[0].id);
    expect(next.subtasks).toHaveLength(1);
    expect(next.subtasks[0].attempts).toBe(1);
  });

  it('flips an in_progress subtask back to pending if still outstanding', () => {
    const prior = reconcilePlan(null, ['- A'], undefined, 1);
    prior.subtasks[0].status = 'in_progress';
    const next = reconcilePlan(prior, ['- A'], undefined, 2);
    expect(next.subtasks[0].status).toBe('pending');
  });
});

describe('pickNextSubtask', () => {
  it('returns null on empty plan', () => {
    expect(pickNextSubtask(freshPlan(), 3)).toBeNull();
  });

  it('skips subtasks at or past maxAttempts', () => {
    const plan = reconcilePlan(null, ['- A', '- B'], undefined, 1);
    plan.subtasks[0].attempts = 3;
    const next = pickNextSubtask(plan, 3);
    expect(next?.text).toBe('- B');
  });

  it('prefers subtasks with fewer attempts (fairness)', () => {
    const plan = reconcilePlan(null, ['- A', '- B'], undefined, 1);
    plan.subtasks[0].attempts = 2;
    plan.subtasks[1].attempts = 0;
    expect(pickNextSubtask(plan, 3)?.text).toBe('- B');
  });

  it('breaks ties by firstSeenIteration (FIFO)', () => {
    const plan = reconcilePlan(null, ['- Older'], undefined, 1);
    const next = reconcilePlan(plan, ['- Older', '- Newer'], undefined, 5);
    expect(pickNextSubtask(next, 3)?.text).toBe('- Older');
  });

  it('skips completed and failed subtasks', () => {
    const plan = reconcilePlan(null, ['- A', '- B'], undefined, 1);
    plan.subtasks[0].status = 'completed';
    plan.subtasks[1].status = 'failed';
    expect(pickNextSubtask(plan, 3)).toBeNull();
  });
});

describe('markExhaustedAsNeedsReframe', () => {
  it('flips pending-at-max to needs_reframe (NOT failed) and reports ids', () => {
    const plan = reconcilePlan(null, ['- A', '- B', '- C'], undefined, 1);
    plan.subtasks[0].attempts = 3;
    plan.subtasks[2].attempts = 5;
    const ids = markExhaustedAsNeedsReframe(plan, 3);
    expect(ids).toHaveLength(2);
    expect(plan.subtasks[0].status).toBe('needs_reframe');
    expect(plan.subtasks[1].status).toBe('pending');
    expect(plan.subtasks[2].status).toBe('needs_reframe');
  });

  it('does nothing when everyone is below the ceiling', () => {
    const plan = reconcilePlan(null, ['- A'], undefined, 1);
    plan.subtasks[0].attempts = 2;
    expect(markExhaustedAsNeedsReframe(plan, 3)).toEqual([]);
    expect(plan.subtasks[0].status).toBe('pending');
  });
});

describe('reframe flow', () => {
  it('replaces a stuck parent with decomposed children when judge provides reframedFrom', () => {
    const initial = reconcilePlan(null, ['- Mirror bot ties'], undefined, 1);
    const parentId = initial.subtasks[0].id;
    initial.subtasks[0].attempts = 3;
    markExhaustedAsNeedsReframe(initial, 3);
    expect(initial.subtasks[0].status).toBe('needs_reframe');

    // Judge comes back with two children decomposing the stuck parent.
    const next = reconcilePlan(
      initial,
      ['Detect last-round tie and switch to BEATS', 'Add epsilon-noise to break cycles'],
      [
        { reframedFrom: parentId, files: ['mirror.ts'] },
        { reframedFrom: parentId, files: ['mirror.ts'] },
      ],
      2,
    );

    const parent = next.subtasks.find((s) => s.id === parentId)!;
    expect(parent.status).toBe('reframed');

    const children = next.subtasks.filter((s) => s.reframedFrom === parentId);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.status === 'pending' && c.attempts === 0)).toBe(true);
    expect(children.every((c) => c.reframeDepth === 1)).toBe(true);
  });

  it('hard-fails a child when reframe depth exceeds MAX_REFRAME_DEPTH', () => {
    const initial = reconcilePlan(null, ['- X'], undefined, 1);
    const first = initial.subtasks[0];
    first.reframeDepth = MAX_REFRAME_DEPTH;
    first.attempts = 3;
    first.status = 'needs_reframe';

    const next = reconcilePlan(
      initial,
      ['Subdivision of X'],
      [{ reframedFrom: first.id }],
      2,
    );
    const child = next.subtasks.find((s) => s.reframedFrom === first.id)!;
    expect(child.status).toBe('failed');
    expect(child.failureReason).toMatch(/max reframe depth/);
  });

  it('marks a subtask blocked when judge emits blocked:true with reframedFrom', () => {
    const initial = reconcilePlan(null, ['- Requires paid account'], undefined, 1);
    const parentId = initial.subtasks[0].id;
    initial.subtasks[0].attempts = 3;
    markExhaustedAsNeedsReframe(initial, 3);

    const next = reconcilePlan(
      initial,
      ['Requires paid Fly account'],
      [{ reframedFrom: parentId, blocked: true, blockedReason: 'needs human with Fly.io paid plan' }],
      2,
    );
    const child = next.subtasks.find((s) => s.reframedFrom === parentId)!;
    expect(child.status).toBe('blocked');
    expect(child.blockedReason).toMatch(/Fly/);
  });

  it('marks a regular (non-reframed) subtask blocked when judge signals blocked on first sight', () => {
    const plan = reconcilePlan(
      null,
      ['Only a human can click this OAuth consent screen'],
      [{ blocked: true, blockedReason: 'OAuth consent needs browser session' }],
      1,
    );
    expect(plan.subtasks[0].status).toBe('blocked');
    expect(plan.subtasks[0].blockedReason).toMatch(/OAuth/);
  });

  it('pickNextSubtask skips needs_reframe, reframed, and blocked subtasks', () => {
    const plan = reconcilePlan(null, ['- A', '- B', '- C'], undefined, 1);
    plan.subtasks[0].status = 'needs_reframe';
    plan.subtasks[1].status = 'reframed';
    plan.subtasks[2].status = 'blocked';
    expect(pickNextSubtask(plan, 3)).toBeNull();
  });
});

describe('collectStuckSubtasks & renderStuckBrief', () => {
  it('collects only needs_reframe subtasks', () => {
    const plan = reconcilePlan(null, ['- A', '- B', '- C'], undefined, 1);
    plan.subtasks[0].status = 'needs_reframe';
    plan.subtasks[2].status = 'needs_reframe';
    const stuck = collectStuckSubtasks(plan);
    expect(stuck.map((s) => s.text)).toEqual(['- A', '- C']);
  });

  it('renders an empty string when nothing is stuck', () => {
    expect(renderStuckBrief([])).toBe('');
  });

  it('renders a brief with id, attempts, reframeDepth, and reframedFrom guidance', () => {
    const plan = reconcilePlan(
      null,
      ['- Fix flaky test'],
      [{ files: ['test/foo.test.ts'], symptom: 'flakes 1/5', acceptance: 'pass 20/20' }],
      1,
    );
    plan.subtasks[0].status = 'needs_reframe';
    plan.subtasks[0].attempts = 3;
    plan.subtasks[0].lastAttemptIteration = 7;
    const brief = renderStuckBrief(plan.subtasks);
    expect(brief).toContain('STUCK SUBTASKS');
    expect(brief).toContain(plan.subtasks[0].id);
    expect(brief).toContain('attempts: 3');
    expect(brief).toContain('reframeDepth: 0');
    expect(brief).toMatch(/reframedFrom/);
    expect(brief).toMatch(/decompose|reframe|block/i);
    expect(brief).toContain('iterations/000007/worker-transcript.md');
  });
});

describe('planSummary', () => {
  it('counts each status bucket', () => {
    const plan: Plan = {
      version: 1,
      updatedAt: new Date().toISOString(),
      subtasks: [
        { id: 'S-001', text: 'a', normalizedKey: 'a', status: 'pending', attempts: 0, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-002', text: 'b', normalizedKey: 'b', status: 'pending', attempts: 1, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-003', text: 'c', normalizedKey: 'c', status: 'in_progress', attempts: 0, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-004', text: 'd', normalizedKey: 'd', status: 'completed', attempts: 2, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-005', text: 'e', normalizedKey: 'e', status: 'needs_reframe', attempts: 3, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-006', text: 'f', normalizedKey: 'f', status: 'reframed', attempts: 3, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-007', text: 'g', normalizedKey: 'g', status: 'blocked', attempts: 0, firstSeenIteration: 1, reframeDepth: 0 },
        { id: 'S-008', text: 'h', normalizedKey: 'h', status: 'failed', attempts: 3, firstSeenIteration: 1, reframeDepth: 3 },
      ],
    };
    expect(planSummary(plan)).toEqual({
      pending: 2,
      in_progress: 1,
      completed: 1,
      needs_reframe: 1,
      reframed: 1,
      blocked: 1,
      failed: 1,
      total: 8,
    });
  });
});

describe('renderSubtaskBrief', () => {
  it('includes the title and files as a bulleted list', () => {
    const plan = reconcilePlan(null, ['Fix X'], [{ files: ['a.ts', 'b.ts'] }], 1);
    const brief = renderSubtaskBrief(plan.subtasks[0]);
    expect(brief).toContain('Fix X');
    expect(brief).toContain('- `a.ts`');
    expect(brief).toContain('- `b.ts`');
    expect(brief).toContain(plan.subtasks[0].id);
  });

  it('includes a retry warning when attempts > 0', () => {
    const plan = reconcilePlan(null, ['- A'], undefined, 1);
    plan.subtasks[0].attempts = 2;
    const brief = renderSubtaskBrief(plan.subtasks[0]);
    expect(brief).toMatch(/Previous attempts did not clear/);
  });

  it('does NOT include a retry warning on first attempt', () => {
    const plan = reconcilePlan(null, ['- A'], undefined, 1);
    const brief = renderSubtaskBrief(plan.subtasks[0]);
    expect(brief).not.toMatch(/Previous attempts/);
  });
});
