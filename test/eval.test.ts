import { describe, it, expect } from 'vitest';
import { decideAfterAttempt, extractEvalVerdict, type EvalAttempt } from '../src/eval.js';

describe('extractEvalVerdict', () => {
  it('parses a passed verdict', () => {
    const text = '\n\nblah\n\n```json\n{"passed": true, "summary": "ok", "blockers": []}\n```\n';
    const v = extractEvalVerdict(text);
    expect(v).toEqual({ passed: true, summary: 'ok', blockers: [], subtasks: undefined });
  });

  it('parses a not-passed verdict with blockers', () => {
    const text = '```json\n{"passed":false,"summary":"empty UI","blockers":["no door","no knife"]}\n```';
    const v = extractEvalVerdict(text);
    expect(v?.passed).toBe(false);
    expect(v?.blockers).toEqual(['no door', 'no knife']);
  });

  it('parses verdict with subtasks', () => {
    const text =
      '```json\n{"passed":false,"summary":"x","blockers":["a"],"subtasks":[{"title":"a","files":["x.ts"]}]}\n```';
    const v = extractEvalVerdict(text);
    expect(v?.subtasks?.[0]?.title).toBe('a');
  });

  it('coerces non-string blockers to strings', () => {
    const text = '```json\n{"passed":false,"summary":"x","blockers":[1,2]}\n```';
    const v = extractEvalVerdict(text);
    expect(v?.blockers).toEqual(['1', '2']);
  });

  it('returns null for invalid JSON', () => {
    expect(extractEvalVerdict('no json here')).toBeNull();
    expect(extractEvalVerdict('```json\nnot valid\n```')).toBeNull();
  });

  it('returns null when passed is missing', () => {
    expect(extractEvalVerdict('```json\n{"summary":"x","blockers":[]}\n```')).toBeNull();
  });

  it('uses the LAST fenced block when multiple exist', () => {
    const text =
      '```json\n{"passed":true,"summary":"first","blockers":[]}\n```\n\nmore text\n\n```json\n{"passed":false,"summary":"final","blockers":["x"]}\n```';
    const v = extractEvalVerdict(text);
    expect(v?.summary).toBe('final');
  });
});

describe('decideAfterAttempt (S-019: SDK crash resilience)', () => {
  const passedJson =
    '```json\n{"passed":true,"summary":"all good","blockers":[]}\n```';
  const failedJson =
    '```json\n{"passed":false,"summary":"x","blockers":["y"]}\n```';

  it('clean finish + verdict → honour verdict', () => {
    const attempt: EvalAttempt = { transcript: `prelude\n${passedJson}\nepilogue`, crashed: false };
    const d = decideAfterAttempt(attempt, false);
    expect(d.kind).toBe('verdict');
    if (d.kind === 'verdict') {
      expect(d.verdict.passed).toBe(true);
      expect(d.verdict.summary).toBe('all good');
    }
  });

  it('clean finish + no verdict → fall-through (no retry — same prompt would produce same content)', () => {
    const attempt: EvalAttempt = { transcript: 'reasoning but no JSON', crashed: false };
    const d = decideAfterAttempt(attempt, false);
    expect(d.kind).toBe('fall-through');
    if (d.kind === 'fall-through') {
      expect(d.verdict.passed).toBe(false);
      expect(d.verdict.blockers[0]).toMatch(/fenced JSON/i);
    }
  });

  it('crash AFTER verdict streamed → still honour the verdict (post-hoc crash)', () => {
    // Exactly the bug shape that triggered S-019: SDK exited with code 1
    // *after* the eval emitted its fenced JSON. The transcript already
    // has the verdict; the caller should ship it, not re-run.
    const attempt: EvalAttempt = {
      transcript: `reasoning…\n${failedJson}\n`,
      crashed: true,
      error: new Error('Claude Code process exited with code 1'),
    };
    const d = decideAfterAttempt(attempt, false);
    expect(d.kind).toBe('verdict');
    if (d.kind === 'verdict') {
      expect(d.verdict.passed).toBe(false);
      expect(d.verdict.blockers).toEqual(['y']);
    }
  });

  it('crash BEFORE verdict + first attempt → retry', () => {
    // The actual S-019 event sequence: eval finished its analysis
    // text ("All 4 iterations produced real commits ✓") but the SDK
    // died before any fenced JSON streamed. Recovery: retry once.
    const attempt: EvalAttempt = {
      transcript: 'All 4 iterations produced real commits and meaningful test additions. ✓',
      crashed: true,
      error: new Error('Claude Code process exited with code 1'),
    };
    const d = decideAfterAttempt(attempt, false);
    expect(d.kind).toBe('retry');
  });

  it('crash BEFORE verdict + retry attempt → fall-through with two-crash blocker', () => {
    const priorErr = new Error('Claude Code process exited with code 1');
    const attempt: EvalAttempt = {
      transcript: 'still no JSON',
      crashed: true,
      error: new Error('Claude Code process exited with code 137'),
    };
    const d = decideAfterAttempt(attempt, true, priorErr);
    expect(d.kind).toBe('fall-through');
    if (d.kind === 'fall-through') {
      expect(d.verdict.passed).toBe(false);
      // Blocker text must match the bullet that triggered S-019 so the
      // brief format remains stable across re-runs.
      expect(d.verdict.blockers).toEqual([
        'Eval crashed twice; re-run is needed before shipping.',
      ]);
      expect(d.verdict.summary).toMatch(/code 137/);
    }
  });

  it('crash BEFORE verdict + retry produces verdict → ship the retry verdict', () => {
    // The happy path of the retry: transient crash on attempt 1, clean
    // verdict on attempt 2.
    const attempt: EvalAttempt = {
      transcript: `analysis\n${passedJson}\n`,
      crashed: false,
    };
    const d = decideAfterAttempt(attempt, true, new Error('attempt 1 crashed'));
    expect(d.kind).toBe('verdict');
    if (d.kind === 'verdict') {
      expect(d.verdict.passed).toBe(true);
    }
  });

  it('retry-attempt with crash BEFORE verdict yields fall-through, not infinite retry', () => {
    // Defends against an off-by-one: even if the retry crashes the
    // exact same way as attempt 1, decideAfterAttempt MUST return
    // fall-through (not retry) — otherwise runEval would loop forever.
    const attempt: EvalAttempt = {
      transcript: '',
      crashed: true,
      error: new Error('Claude Code process exited with code 1'),
    };
    const d = decideAfterAttempt(attempt, true);
    expect(d.kind).toBe('fall-through');
  });

  it('two-crash fall-through uses prior error message when current is undefined', () => {
    const priorErr = new Error('Claude Code process exited with code 1');
    const attempt: EvalAttempt = { transcript: '', crashed: true /* no error field */ };
    const d = decideAfterAttempt(attempt, true, priorErr);
    expect(d.kind).toBe('fall-through');
    if (d.kind === 'fall-through') expect(d.verdict.summary).toMatch(/code 1/);
  });
});
