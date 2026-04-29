import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedPathsBetween,
  detectStagnation,
  jaccard,
  normalizeBullet,
  touchesAutopilotInternals,
  workingTreeStatus,
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

describe('touchesAutopilotInternals (S-024 self-drive guard)', () => {
  it('flags any path under src/, dist/, skills/, or bin/', () => {
    expect(touchesAutopilotInternals(['src/judge.ts'])).toBe(true);
    expect(touchesAutopilotInternals(['dist/judge.js'])).toBe(true);
    expect(touchesAutopilotInternals(['skills/judge/SKILL.md'])).toBe(true);
    expect(touchesAutopilotInternals(['bin/autopilot.js'])).toBe(true);
  });

  it('flags package.json and package-lock.json (deps may shift behavior)', () => {
    expect(touchesAutopilotInternals(['package.json'])).toBe(true);
    expect(touchesAutopilotInternals(['package-lock.json'])).toBe(true);
  });

  it('does NOT flag worklog, README, tests, or arbitrary docs', () => {
    expect(touchesAutopilotInternals(['WORKLOG.md'])).toBe(false);
    expect(touchesAutopilotInternals(['README.md'])).toBe(false);
    expect(touchesAutopilotInternals(['test/judge.test.ts'])).toBe(false);
    expect(touchesAutopilotInternals(['docs/foo.md'])).toBe(false);
    expect(touchesAutopilotInternals(['.autopilot/state.json'])).toBe(false);
  });

  it('returns false on an empty path list', () => {
    expect(touchesAutopilotInternals([])).toBe(false);
  });

  it('returns true when ANY path in a mixed list is internal', () => {
    expect(touchesAutopilotInternals(['WORKLOG.md', 'src/autopilot.ts', 'README.md'])).toBe(true);
  });
});

describe('changedPathsBetween (S-024 self-drive guard)', () => {
  it('returns the list of files changed between two SHAs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'autopilot-changedpaths-'));
    const sh = (args: string[]): string =>
      execFileSync('git', ['-C', tmp, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim();
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    writeFileSync(join(tmp, 'README.md'), 'x\n');
    sh(['add', 'README.md']);
    sh(['commit', '-q', '-m', 'init']);
    const before = sh(['rev-parse', 'HEAD']);
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src/judge.ts'), 'export const x = 1;\n');
    writeFileSync(join(tmp, 'WORKLOG.md'), 'log\n');
    sh(['add', 'src/judge.ts', 'WORKLOG.md']);
    sh(['commit', '-q', '-m', 'two files']);
    const after = sh(['rev-parse', 'HEAD']);
    const changed = changedPathsBetween(tmp, before, after);
    expect(changed.sort()).toEqual(['WORKLOG.md', 'src/judge.ts']);
    expect(touchesAutopilotInternals(changed)).toBe(true);
  });

  it('returns [] when from===to', () => {
    expect(changedPathsBetween('/tmp/anything', 'abc', 'abc')).toEqual([]);
  });

  it('returns [] when either SHA is null', () => {
    expect(changedPathsBetween('/tmp/anything', null, 'abc')).toEqual([]);
    expect(changedPathsBetween('/tmp/anything', 'abc', null)).toEqual([]);
  });

  it('returns [] for a non-git path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'autopilot-changedpaths-nogit-'));
    expect(changedPathsBetween(tmp, 'a', 'b')).toEqual([]);
  });
});

describe('workingTreeStatus (S-029 half-wired-tree detector)', () => {
  const initRepo = (): { tmp: string; sh: (args: string[]) => string } => {
    const tmp = mkdtempSync(join(tmpdir(), 'autopilot-wt-'));
    const sh = (args: string[]): string =>
      execFileSync('git', ['-C', tmp, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      }).trim();
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    writeFileSync(join(tmp, 'README.md'), 'x\n');
    sh(['add', 'README.md']);
    sh(['commit', '-q', '-m', 'init']);
    return { tmp, sh };
  };

  it('returns clean for a fresh post-commit working tree', () => {
    const { tmp } = initRepo();
    const wt = workingTreeStatus(tmp);
    expect(wt.dirty).toBe(false);
    expect(wt.modifiedFiles).toEqual([]);
    expect(wt.untrackedFiles).toEqual([]);
  });

  it('reports unstaged modifications as modified, not untracked', () => {
    const { tmp } = initRepo();
    writeFileSync(join(tmp, 'README.md'), 'changed\n');
    const wt = workingTreeStatus(tmp);
    expect(wt.dirty).toBe(true);
    expect(wt.modifiedFiles).toContain('README.md');
    expect(wt.untrackedFiles).toEqual([]);
  });

  it('reports staged additions as modified', () => {
    const { tmp, sh } = initRepo();
    writeFileSync(join(tmp, 'new.ts'), 'export const x = 1;\n');
    sh(['add', 'new.ts']);
    const wt = workingTreeStatus(tmp);
    expect(wt.dirty).toBe(true);
    expect(wt.modifiedFiles).toContain('new.ts');
    expect(wt.untrackedFiles).toEqual([]);
  });

  it('reports never-added files as untracked', () => {
    const { tmp } = initRepo();
    writeFileSync(join(tmp, 'orphan.ts'), 'export const y = 2;\n');
    const wt = workingTreeStatus(tmp);
    expect(wt.dirty).toBe(true);
    expect(wt.modifiedFiles).toEqual([]);
    expect(wt.untrackedFiles).toEqual(['orphan.ts']);
  });

  it('reproduces the iter-7 misfire signature: ≥1 modified + ≥1 untracked', () => {
    // The exact failure shape: worker partially edited a tracked file
    // (Character.ts) AND created a new file (EffectPlayer.ts) but never
    // committed either. Both must surface so the orchestrator/next worker
    // can see the recoverable in-flight work.
    const { tmp, sh } = initRepo();
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src/Character.ts'), 'export const c = 0;\n');
    sh(['add', 'src/Character.ts']);
    sh(['commit', '-q', '-m', 'add Character']);

    writeFileSync(join(tmp, 'src/Character.ts'), 'export const c = 1; // partial edit\n');
    writeFileSync(join(tmp, 'src/EffectPlayer.ts'), 'export class P {}\n');

    const wt = workingTreeStatus(tmp);
    expect(wt.dirty).toBe(true);
    expect(wt.modifiedFiles).toEqual(['src/Character.ts']);
    expect(wt.untrackedFiles).toEqual(['src/EffectPlayer.ts']);
  });

  it('handles paths with spaces correctly via NUL-delimited porcelain', () => {
    const { tmp } = initRepo();
    writeFileSync(join(tmp, 'has space.txt'), 'spaced\n');
    const wt = workingTreeStatus(tmp);
    expect(wt.untrackedFiles).toEqual(['has space.txt']);
  });

  it('returns clean for a non-git path without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'autopilot-wt-nogit-'));
    const wt = workingTreeStatus(tmp);
    expect(wt.dirty).toBe(false);
    expect(wt.modifiedFiles).toEqual([]);
    expect(wt.untrackedFiles).toEqual([]);
  });
});
