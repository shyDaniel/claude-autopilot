import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractVerdict,
  buildJsonOnlyRetryPrompt,
  synthesizeFallbackVerdict,
  lastProseChunks,
} from '../src/judge.js';

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

describe('buildJsonOnlyRetryPrompt (S-022)', () => {
  it('returns null when transcript is empty', () => {
    expect(buildJsonOnlyRetryPrompt('')).toBeNull();
  });

  it('returns null when transcript is below the substance floor', () => {
    expect(buildJsonOnlyRetryPrompt('hi there')).toBeNull();
  });

  it('returns null when only tool/thinking marker noise is present', () => {
    const txt = [
      '[tool: Bash] (command=ls)',
      '[tool: Read] (file_path=foo)',
      '[thinking]',
      '[tool: Bash] (command=cat)',
    ].join('\n');
    expect(buildJsonOnlyRetryPrompt(txt)).toBeNull();
  });

  it('embeds the prose tail when transcript has substance', () => {
    const conclusion =
      'After a thorough review the repo is in good shape but a few specific polish ' +
      'defects remain in the autopilot log command rendering pipeline as observed.';
    const out = buildJsonOnlyRetryPrompt(conclusion);
    expect(out).not.toBeNull();
    expect(out!).toContain('YOUR PRIOR ANALYSIS');
    expect(out!).toContain('autopilot log command rendering pipeline');
    expect(out!).toContain('fenced ```json block');
    expect(out!).toContain('NO prose before or after');
  });

  it('strips tool-marker lines from the embedded tail', () => {
    const txt = [
      'Initial analysis lays out the rubric',
      '[tool: Bash] (command=npm test)',
      '[tool: Read] (file_path=src/index.ts)',
      'Real conclusion: the product is high-quality and very close to done. ' +
        'But the observable log defects remain — needs another iteration.',
    ].join('\n');
    const out = buildJsonOnlyRetryPrompt(txt)!;
    expect(out).toContain('observable log defects remain');
    expect(out).not.toContain('[tool: Bash]');
    expect(out).not.toContain('[tool: Read]');
  });

  it('truncates very long transcripts to ~3000 chars with leading ellipsis', () => {
    const long = 'A'.repeat(10_000);
    const out = buildJsonOnlyRetryPrompt(long)!;
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(long.length);
  });
});

describe('synthesizeFallbackVerdict (S-022)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'judge-fallback-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports missing FINAL_GOAL.md when the file is genuinely absent', () => {
    const v = synthesizeFallbackVerdict(
      'Some prose conclusion that proves the judge actually ran.',
      tmp,
    );
    expect(v.done).toBe(false);
    expect(v.summary).toMatch(/FINAL_GOAL\.md is missing/);
    expect(v.outstanding[0]).toMatch(/Create FINAL_GOAL\.md/);
  });

  it('does NOT mention FINAL_GOAL.md in the outstanding bullet when it exists (the S-022 misfire)', () => {
    writeFileSync(join(tmp, 'FINAL_GOAL.md'), '# goal\n\nshippable thing.\n');
    const proseConclusion =
      'Real work, real commit, no autopilot misfire. The product as a whole is ' +
      'high-quality and very close to done. But the observable log defects remain.';
    const v = synthesizeFallbackVerdict(proseConclusion, tmp);
    expect(v.done).toBe(false);
    for (const bullet of v.outstanding) {
      expect(bullet).not.toMatch(/FINAL_GOAL\.md is present and well-formed/);
      expect(bullet).not.toMatch(/Create FINAL_GOAL\.md/);
    }
    expect(v.outstanding[0]).toMatch(/fenced JSON|JSON verdict/i);
  });

  it("preserves the judge's prose conclusion verbatim in summary so context isn't lost", () => {
    writeFileSync(join(tmp, 'FINAL_GOAL.md'), '# goal\n');
    const proseConclusion =
      'Concrete defects observed: log shows missing iter 2 in session 4 and ' +
      'multiple sessions report running for iters that finished long ago.';
    const v = synthesizeFallbackVerdict(proseConclusion, tmp);
    expect(v.summary).toContain('missing iter 2 in session 4');
    expect(v.summary).toContain('multiple sessions report running');
  });

  it('handles empty transcripts with a distinct, honest blocker', () => {
    writeFileSync(join(tmp, 'FINAL_GOAL.md'), '# goal\n');
    const v = synthesizeFallbackVerdict('', tmp);
    expect(v.done).toBe(false);
    expect(v.summary).toMatch(/substantive prose/);
    expect(v.outstanding[0]).toMatch(/produced no analysis/);
    expect(v.summary).not.toMatch(/FINAL_GOAL\.md is missing/);
  });

  it('treats a transcript of pure tool noise as effectively empty', () => {
    writeFileSync(join(tmp, 'FINAL_GOAL.md'), '# goal\n');
    const noise = ['[tool: Bash] (command=ls)', '[tool: Read] (file_path=x)', '[thinking]'].join('\n');
    const v = synthesizeFallbackVerdict(noise, tmp);
    expect(v.summary).toMatch(/substantive prose/);
  });

  it('regression: matches the iter-4 transcript shape from this repo (S-022)', () => {
    // This fixture mirrors the shape of the actual iter 4 judge transcript:
    // a long working session that ends with a prose conclusion instead of
    // fenced JSON. The synthesized verdict MUST NOT blame FINAL_GOAL.md.
    writeFileSync(join(tmp, 'FINAL_GOAL.md'), '# agent-autopilot\n\n## Vision\n\n…\n');
    const transcript = [
      "I'll judge this repository against the shipping criteria.",
      '[tool: Bash] (command=ls)',
      '[tool: Read] (file_path=FINAL_GOAL.md)',
      'This is a developer automation tool, not malware. Continuing.',
      '[tool: Bash] (command=npm test)',
      '169/169 tests pass, build clean. Verifying CLI behavior now.',
      '[tool: Bash] (command=node bin/autopilot.js log .)',
      'Multiple sessions show running status for iters that finished long ago, ' +
        'missing iter 2 in session 4. Real polish defects.',
      'Real work, real commit, no autopilot misfire. The product as a whole is ' +
        'high-quality and very close to done. But the observable log defects remain.',
    ].join('\n');

    const v = synthesizeFallbackVerdict(transcript, tmp);

    expect(v.done).toBe(false);
    expect(v.outstanding.join(' ')).not.toMatch(/FINAL_GOAL\.md is present and well-formed/);
    expect(v.outstanding[0]).toMatch(/fenced JSON|JSON verdict/i);
    expect(v.summary).toContain('observable log defects remain');
  });
});

describe('lastProseChunks (S-022)', () => {
  it('returns empty string for empty input', () => {
    expect(lastProseChunks('', 100)).toBe('');
  });

  it('strips tool marker lines and thinking markers', () => {
    const txt = ['Hello world', '[tool: Bash] (command=ls)', '[thinking]', 'Conclusion line'].join(
      '\n',
    );
    const out = lastProseChunks(txt, 1000);
    expect(out).toContain('Hello world');
    expect(out).toContain('Conclusion line');
    expect(out).not.toContain('[tool: Bash]');
    expect(out).not.toContain('[thinking]');
  });

  it('returns the full cleaned text when within the cap', () => {
    expect(lastProseChunks('short text', 1000)).toBe('short text');
  });

  it('keeps the TAIL (not the head) when input exceeds cap', () => {
    const txt = 'AAA'.repeat(200) + 'TAIL_MARKER';
    const out = lastProseChunks(txt, 50);
    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('TAIL_MARKER');
  });
});
