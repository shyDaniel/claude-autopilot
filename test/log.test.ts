import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { partitionSessions, renderSession } from '../src/commands/log.js';
import type { AutopilotEvent } from '../src/events.js';

// Pin local timezone so date-boundary detection is deterministic regardless of where the suite runs.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function evt(partial: Partial<AutopilotEvent> & Pick<AutopilotEvent, 'ts' | 'iter' | 'phase' | 'kind'>): AutopilotEvent {
  return partial as AutopilotEvent;
}

describe('log command', () => {
  it('partitions multiple autopilot sessions by iter==0 loop start markers', () => {
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T07:54:49.225Z', iter: 0, phase: 'loop', kind: 'start', msg: 'pid=1' }),
      evt({ ts: '2026-04-29T07:54:49.227Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:05:44.949Z', iter: 1, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-29T09:00:55.288Z', iter: 0, phase: 'loop', kind: 'start', msg: 'pid=2' }),
      evt({ ts: '2026-04-29T09:00:55.290Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T09:12:25.452Z', iter: 1, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].rows.get(1)?.startedAt).toBe('2026-04-29T07:54:49.227Z');
    expect(sessions[1].rows.get(1)?.startedAt).toBe('2026-04-29T09:00:55.290Z');
  });

  it('renders rows in monotonically non-decreasing started order within a session', () => {
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T07:54:49.225Z', iter: 0, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T07:54:49.227Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:05:44.949Z', iter: 1, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-29T08:05:45.951Z', iter: 2, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:11:54.812Z', iter: 2, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-29T08:11:55.818Z', iter: 3, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:27:23.356Z', iter: 3, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    const rendered = renderSession(sessions[0]);
    const startedTimes = rendered.rows.map((r) => r.started);
    const sorted = [...startedTimes].sort();
    expect(startedTimes).toEqual(sorted);
  });

  it('does not display backwards times when sessions interleave the same iter number (S-020 regression)', () => {
    // Reproduces the bug from this very repo: iter 1 from session 1 ended at 08:05,
    // iter 1 from session 2 started at 09:00 — last-write-wins on a Map keyed only by
    // iter number caused 'iter 1 started 09:00 ended 08:05' to render.
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T07:54:49.225Z', iter: 0, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T07:54:49.227Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:05:44.949Z', iter: 1, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-29T09:00:55.288Z', iter: 0, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T09:00:55.290Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T09:12:25.452Z', iter: 1, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    // Default rendering targets the most recent session.
    const rendered = renderSession(sessions[sessions.length - 1]);
    expect(rendered.rows).toHaveLength(1);
    const row = rendered.rows[0];
    // Started must be ≤ ended → duration is non-negative and not '—'.
    expect(row.duration).not.toBe('—');
    expect(row.duration).toMatch(/^\d+m\d+s$|^\d+s$|^\d+h\d+m$/);
  });

  it('renders a date-prefixed started column when a single session spans more than one UTC day', () => {
    // 23:30 UTC → 00:30 UTC the next day. Even when the user's local timezone agrees,
    // we must include the date prefix so two different days are distinguishable.
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T22:00:00.000Z', iter: 0, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T23:30:00.000Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-30T00:15:00.000Z', iter: 1, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-30T00:16:00.000Z', iter: 2, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-30T01:00:00.000Z', iter: 2, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    const rendered = renderSession(sessions[0]);
    expect(rendered.spansMultipleDays).toBe(true);
    // Date prefix YYYY-MM-DD HH:MM:SS for both rows.
    expect(rendered.rows[0].started).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(rendered.rows[1].started).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Acceptance: row N's started ≤ row N+1's started (lexicographic compare works for the date-prefixed format).
    expect(rendered.rows[0].started <= rendered.rows[1].started).toBe(true);
  });

  it('replaces the literal "?" verdict placeholder with a clean "outstanding" or em-dash', () => {
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T07:54:49.225Z', iter: 0, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T07:54:49.227Z', iter: 1, phase: 'loop', kind: 'start' }),
      // Verdict event with no `outstanding` array — previous code printed "? outstanding".
      evt({ ts: '2026-04-29T08:00:00.000Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false } } }),
      evt({ ts: '2026-04-29T08:05:44.949Z', iter: 1, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-29T08:05:45.951Z', iter: 2, phase: 'loop', kind: 'start' }),
      // No verdict event at all for iter 2 — should not show "?".
      evt({ ts: '2026-04-29T08:11:54.812Z', iter: 2, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    const rendered = renderSession(sessions[0]);
    for (const row of rendered.rows) {
      expect(row.verdict).not.toContain('?');
    }
    expect(rendered.rows[0].verdict).toBe('outstanding');
    expect(rendered.rows[1].verdict).toBe('—');
  });

  it('renders DONE verdicts and counted outstanding verdicts as before', () => {
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T07:54:49.225Z', iter: 0, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T07:54:49.227Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:00:00.000Z', iter: 1, phase: 'judge', kind: 'verdict', data: { verdict: { done: false, outstanding: ['a', 'b', 'c'] } } }),
      evt({ ts: '2026-04-29T08:05:44.949Z', iter: 1, phase: 'loop', kind: 'end' }),
      evt({ ts: '2026-04-29T08:05:45.951Z', iter: 2, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:10:00.000Z', iter: 2, phase: 'judge', kind: 'verdict', data: { verdict: { done: true, outstanding: [] } } }),
      evt({ ts: '2026-04-29T08:11:54.812Z', iter: 2, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    const rendered = renderSession(sessions[0]);
    expect(rendered.rows[0].verdict).toBe('3 outstanding');
    expect(rendered.rows[1].verdict).toBe('DONE');
  });

  it('attributes events that arrive before any session marker to a leading session', () => {
    // Legacy logs that pre-date the iter==0 start marker should still render rather than vanish.
    const events: AutopilotEvent[] = [
      evt({ ts: '2026-04-29T07:54:49.227Z', iter: 1, phase: 'loop', kind: 'start' }),
      evt({ ts: '2026-04-29T08:05:44.949Z', iter: 1, phase: 'loop', kind: 'end' }),
    ];
    const sessions = partitionSessions(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].rows.get(1)?.startedAt).toBe('2026-04-29T07:54:49.227Z');
  });
});
