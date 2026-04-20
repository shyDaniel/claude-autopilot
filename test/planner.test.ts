import { describe, it, expect } from 'vitest';
import {
  freshPlan,
  reconcilePlan,
  pickNextSubtask,
  markExhaustedAsFailed,
  planSummary,
  renderSubtaskBrief,
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

  it('preserves failed markers across iterations', () => {
    const prior = reconcilePlan(null, ['- A'], undefined, 1);
    prior.subtasks[0].status = 'failed';
    prior.subtasks[0].failureReason = 'gave up';
    const next = reconcilePlan(prior, [], undefined, 2);
    const a = next.subtasks.find((s) => s.text === '- A')!;
    expect(a.status).toBe('failed');
    expect(a.failureReason).toBe('gave up');
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

describe('markExhaustedAsFailed', () => {
  it('transitions pending-at-max to failed and reports ids', () => {
    const plan = reconcilePlan(null, ['- A', '- B', '- C'], undefined, 1);
    plan.subtasks[0].attempts = 3;
    plan.subtasks[2].attempts = 5;
    const ids = markExhaustedAsFailed(plan, 3);
    expect(ids).toHaveLength(2);
    expect(plan.subtasks[0].status).toBe('failed');
    expect(plan.subtasks[1].status).toBe('pending');
    expect(plan.subtasks[2].status).toBe('failed');
  });

  it('does nothing when everyone is below the ceiling', () => {
    const plan = reconcilePlan(null, ['- A'], undefined, 1);
    plan.subtasks[0].attempts = 2;
    expect(markExhaustedAsFailed(plan, 3)).toEqual([]);
    expect(plan.subtasks[0].status).toBe('pending');
  });
});

describe('planSummary', () => {
  it('counts each status bucket', () => {
    const plan: Plan = {
      version: 1,
      updatedAt: new Date().toISOString(),
      subtasks: [
        { id: 'S-001', text: 'a', normalizedKey: 'a', status: 'pending', attempts: 0, firstSeenIteration: 1 },
        { id: 'S-002', text: 'b', normalizedKey: 'b', status: 'pending', attempts: 1, firstSeenIteration: 1 },
        { id: 'S-003', text: 'c', normalizedKey: 'c', status: 'in_progress', attempts: 0, firstSeenIteration: 1 },
        { id: 'S-004', text: 'd', normalizedKey: 'd', status: 'completed', attempts: 2, firstSeenIteration: 1 },
        { id: 'S-005', text: 'e', normalizedKey: 'e', status: 'failed', attempts: 3, firstSeenIteration: 1 },
      ],
    };
    expect(planSummary(plan)).toEqual({
      pending: 2,
      in_progress: 1,
      completed: 1,
      failed: 1,
      total: 5,
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
