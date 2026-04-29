import { describe, it, expect } from 'vitest';
import { extractOrchestratorVerdict } from '../src/orchestrator.js';

describe('extractOrchestratorVerdict', () => {
  it('parses a work decision', () => {
    const text = '```json\n{"next_skill":"work","reason":"making progress"}\n```';
    const v = extractOrchestratorVerdict(text);
    expect(v?.next_skill).toBe('work');
    expect(v?.reason).toBe('making progress');
    expect(v?.evolve_target).toBeNull();
  });

  it('parses an evolve decision with target', () => {
    const text =
      '```json\n{"next_skill":"evolve","reason":"judge keeps accepting empty UIs","evolve_target":"skills/judge/SKILL.md"}\n```';
    const v = extractOrchestratorVerdict(text);
    expect(v?.next_skill).toBe('evolve');
    expect(v?.evolve_target).toBe('skills/judge/SKILL.md');
  });

  it('parses a reframe decision', () => {
    const text =
      '```json\n{"next_skill":"reframe","reason":"stuck on subtask 4","reframe_target_subtask_id":"st-4"}\n```';
    const v = extractOrchestratorVerdict(text);
    expect(v?.next_skill).toBe('reframe');
    expect(v?.reframe_target_subtask_id).toBe('st-4');
  });

  it('parses exit-stuck', () => {
    const text = '```json\n{"next_skill":"exit-stuck","reason":"3 refinements exhausted"}\n```';
    const v = extractOrchestratorVerdict(text);
    expect(v?.next_skill).toBe('exit-stuck');
  });

  it('rejects unknown next_skill values', () => {
    const text = '```json\n{"next_skill":"sleep","reason":"why not"}\n```';
    expect(extractOrchestratorVerdict(text)).toBeNull();
  });

  it('rejects missing reason', () => {
    const text = '```json\n{"next_skill":"work"}\n```';
    expect(extractOrchestratorVerdict(text)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractOrchestratorVerdict('no json')).toBeNull();
    expect(extractOrchestratorVerdict('```json\nnope\n```')).toBeNull();
  });

  it('uses the LAST fenced block when multiple exist', () => {
    const text =
      '```json\n{"next_skill":"work","reason":"a"}\n```\n```json\n{"next_skill":"evolve","reason":"b"}\n```';
    const v = extractOrchestratorVerdict(text);
    expect(v?.next_skill).toBe('evolve');
  });
});
