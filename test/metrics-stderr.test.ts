import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  snapshotRepo,
  commitsBetween,
  diffBetween,
  fullDiffBetween,
} from '../src/metrics.js';

/**
 * Regression test for S-014: when autopilot helpers run against a freshly
 * `git init`'d repo with zero commits, git emits "fatal: ambiguous argument
 * 'HEAD'" to stderr. Without `stdio: ['ignore', 'pipe', 'pipe']`, that
 * stderr is inherited and leaks to the parent TTY *before* the JS try/catch
 * can swallow the throw — the fallback string returns cleanly but the
 * cosmetic noise has already been written to FD 2.
 *
 * These tests assert no stderr is written when the helpers fail on an
 * empty repo. They run the helpers both in-process (smoke) and in a
 * child process (FD-level capture, the only way to catch true stderr leaks).
 */

async function makeEmptyGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-stderr-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  // Ensure no commits exist — `git rev-parse HEAD` will fail with
  // "fatal: ambiguous argument 'HEAD': unknown revision".
  return dir;
}

describe('metrics helpers on empty git repo', () => {
  it('snapshotRepo returns sentinel without throwing on zero-commit repo', async () => {
    const repo = await makeEmptyGitRepo();
    const snap = snapshotRepo(repo);
    // git rev-parse HEAD failed → headSha falls back to null
    expect(snap.headSha).toBeNull();
    expect(snap.commitCountTotal).toBe(0);
  });

  it('commitsBetween returns [] without throwing on zero-commit repo', async () => {
    const repo = await makeEmptyGitRepo();
    expect(commitsBetween(repo, null, 'HEAD')).toEqual([]);
  });

  it('diffBetween returns "" without throwing on zero-commit repo', async () => {
    const repo = await makeEmptyGitRepo();
    expect(diffBetween(repo, 'HEAD~', 'HEAD')).toBe('');
  });

  it('fullDiffBetween returns "" without throwing on zero-commit repo', async () => {
    const repo = await makeEmptyGitRepo();
    expect(fullDiffBetween(repo, 'HEAD~', 'HEAD')).toBe('');
  });
});

describe('git stderr does not leak through helper try/catch', () => {
  // The bug is FD-level: execFileSync without stdio:'pipe' for stderr
  // inherits the parent's FD 2, so even when the JS exception is caught,
  // git's "fatal: ..." message has already been written to the parent TTY.
  //
  // We can only catch this by spawning a child node process and observing
  // its stderr buffer, because vitest doesn't intercept inherited FDs.
  it('running helpers against an empty git repo writes nothing to process.stderr', async () => {
    const repo = await makeEmptyGitRepo();
    // Run the helpers in a fresh subprocess and capture both streams
    // separately. The src is TS, so use tsx via node --import. We invoke
    // through the package's own tsx (the same path npm test uses).
    const script = `
      import('${new URL('../src/metrics.ts', import.meta.url).href}').then((m) => {
        m.snapshotRepo(${JSON.stringify(repo)});
        m.commitsBetween(${JSON.stringify(repo)}, null, 'HEAD');
        m.diffBetween(${JSON.stringify(repo)}, 'HEAD~', 'HEAD');
        m.fullDiffBetween(${JSON.stringify(repo)}, 'HEAD~', 'HEAD');
      });
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: new URL('..', import.meta.url).pathname,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Helper script failed unexpectedly. status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
      );
    }
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    // The whole point: zero "fatal: ambiguous argument" leaks.
    expect(stderr).not.toMatch(/fatal:/i);
    expect(stderr).not.toMatch(/ambiguous argument/i);
    expect(stderr).toBe('');
    // Sanity: the helpers themselves don't print to stdout either.
    expect(stdout).toBe('');
  }, 30_000);
});
