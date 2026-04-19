import { describe, it, expect } from 'vitest';
import {
  detectStagnation,
  jaccard,
  normalizeBullet,
  type IterationSnapshot,
} from '../src/metrics.js';

describe('normalizeBullet', () => {
  it('lowercases and strips list markers', () => {
    expect(normalizeBullet('- Add Unit Tests')).toBe('add unit tests');
    expect(normalizeBullet('  * Add   unit tests ')).toBe('add unit tests');
    expect(normalizeBullet('1. Add unit tests')).toBe('add unit tests');
    expect(normalizeBullet('• Implement login')).toBe('implement login');
  });

  it('treats trivial rewordings as identical after normalization', () => {
    expect(normalizeBullet('- Add Unit Tests')).toBe(normalizeBullet('1. add   unit tests'));
  });
});

describe('jaccard', () => {
  it('returns 1 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  it('returns 0 for disjoint non-empty sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  it('computes intersection/union correctly', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(2 / 4);
  });
  it('treats two empty sets as identical', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe('detectStagnation', () => {
  const make = (iter: number, outstanding: string[], commits: number): IterationSnapshot => ({
    iter,
    outstanding,
    outstandingSummary: '',
    headSha: `sha${iter}`,
    commitCountTotal: commits,
  });

  it('does not fire before it has enough history', () => {
    const h = [make(1, ['- a', '- b'], 1), make(2, ['- a', '- b'], 1)];
    expect(detectStagnation(h, 3).stagnant).toBe(false);
  });

  it('fires when outstanding stays identical AND no commits land', () => {
    const h = [
      make(1, ['- a', '- b'], 5),
      make(2, ['- a', '- b'], 5),
      make(3, ['- a', '- b'], 5),
      make(4, ['- a', '- b'], 5),
    ];
    const r = detectStagnation(h, 3);
    expect(r.stagnant).toBe(true);
    expect(r.recentSimilarities.every((s) => s >= 0.9)).toBe(true);
  });

  it('does NOT fire if commits are landing', () => {
    const h = [
      make(1, ['- a', '- b'], 5),
      make(2, ['- a', '- b'], 6),
      make(3, ['- a', '- b'], 7),
      make(4, ['- a', '- b'], 8),
    ];
    expect(detectStagnation(h, 3).stagnant).toBe(false);
  });

  it('does NOT fire if outstanding list shrinks', () => {
    const h = [
      make(1, ['- a', '- b', '- c'], 5),
      make(2, ['- a', '- b'], 5),
      make(3, ['- a'], 5),
      make(4, [], 5),
    ];
    expect(detectStagnation(h, 3).stagnant).toBe(false);
  });

  it('is resilient to reordering / case changes in bullets', () => {
    const h = [
      make(1, ['- Add tests', '- Add docs'], 10),
      make(2, ['- add docs', '- Add Tests'], 10),
      make(3, ['1. ADD tests', '2. add DOCS'], 10),
      make(4, ['• Add tests', '• Add docs'], 10),
    ];
    expect(detectStagnation(h, 3).stagnant).toBe(true);
  });
});
