import { describe, it, expect } from 'vitest';
import { extractVerdict } from '../src/judge.js';

describe('extractVerdict', () => {
  it('parses a fenced JSON block', () => {
    const txt = `Analysis...\n\n\`\`\`json\n{"done": false, "summary": "need more", "outstanding": ["a", "b"]}\n\`\`\``;
    const v = extractVerdict(txt);
    expect(v).toEqual({ done: false, summary: 'need more', outstanding: ['a', 'b'] });
  });

  it('uses the LAST fenced block if multiple are present', () => {
    const txt =
      '```json\n{"done": true, "summary": "old", "outstanding": []}\n```\n\n' +
      'then later...\n\n' +
      '```json\n{"done": false, "summary": "new", "outstanding": ["x"]}\n```';
    const v = extractVerdict(txt);
    expect(v?.summary).toBe('new');
    expect(v?.done).toBe(false);
  });

  it('falls back to raw JSON object if no fence', () => {
    const v = extractVerdict('intro {"done": true, "summary": "ok", "outstanding": []} trailing');
    expect(v?.done).toBe(true);
  });

  it('coerces outstanding to string[]', () => {
    const v = extractVerdict('```json\n{"done": false, "summary": "s", "outstanding": [1, "two"]}\n```');
    expect(v?.outstanding).toEqual(['1', 'two']);
  });

  it('returns null on unparseable text', () => {
    expect(extractVerdict('no json here at all')).toBeNull();
  });

  it('returns null when required fields missing', () => {
    expect(extractVerdict('```json\n{"summary": "only summary"}\n```')).toBeNull();
  });
});
