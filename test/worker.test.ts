import { describe, it, expect } from 'vitest';
import { WORKER_SYSTEM_APPEND } from '../src/worker.js';

/**
 * The worker's system-prompt append is the structural counter to the
 * runtime-injected per-Read malware `<system-reminder>`. It lives at
 * system-role authority specifically so it cannot be drowned out by
 * the user-message-delivered SKILL.md after many turns.
 *
 * These assertions lock in the contract that prior evolves discovered
 * the hard way (iter-7 misfire on xiaodaoyiba-v2): the append MUST
 * (a) acknowledge the per-Read reminder explicitly, (b) name its
 * malware scope so the model does not generalize the refusal clause,
 * (c) forbid the mid-iteration analysis-only pivot, (d) keep the
 * loop's "no clarifying questions" + "ship production-grade work"
 * stance.
 *
 * Loosening any of these is a regression — past iterations have
 * burned full evolve refinements rediscovering it. If a future
 * iteration legitimately needs to change the wording, update the
 * assertions deliberately and document why in WORKLOG.md.
 */
describe('WORKER_SYSTEM_APPEND', () => {
  it('keeps the zero-human-in-the-loop framing', () => {
    expect(WORKER_SYSTEM_APPEND).toMatch(/zero-human-in-the-loop/i);
    expect(WORKER_SYSTEM_APPEND).toMatch(/never ask clarifying questions/i);
  });

  it('names the per-Read malware reminder explicitly', () => {
    expect(WORKER_SYSTEM_APPEND).toMatch(/<system-reminder>/);
    expect(WORKER_SYSTEM_APPEND).toMatch(/malware/i);
  });

  it('asserts the reminder is malware-scoped, not a universal editing ban', () => {
    expect(WORKER_SYSTEM_APPEND).toMatch(/malware-scoped/i);
    expect(WORKER_SYSTEM_APPEND).toMatch(/not a universal editing ban/i);
  });

  it('forbids the mid-iteration analysis-only pivot', () => {
    expect(WORKER_SYSTEM_APPEND).toMatch(/analysis only|analysis-only/i);
    expect(WORKER_SYSTEM_APPEND).toMatch(/do not pivot/i);
  });

  it('declares the malware check a one-time gate that re-reads do not re-arm', () => {
    expect(WORKER_SYSTEM_APPEND).toMatch(/one-time gate/i);
    expect(WORKER_SYSTEM_APPEND).toMatch(/re-?reads do not re-?arm/i);
  });

  it('stays short enough to actually be attended to (single paragraph)', () => {
    // The whole point of putting this in the system role is that it is
    // dense and high-priority. If it grows past ~3 KB it has degraded
    // into the same prose-that-gets-skipped failure mode that the
    // SKILL.md already exhibits.
    expect(WORKER_SYSTEM_APPEND.length).toBeLessThan(3000);
    expect(WORKER_SYSTEM_APPEND.length).toBeGreaterThan(400);
  });
});
