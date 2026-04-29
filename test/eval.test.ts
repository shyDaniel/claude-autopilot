import { describe, it, expect } from 'vitest';
import { extractEvalVerdict } from '../src/eval.js';

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
