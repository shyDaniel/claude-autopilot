import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoMetrics {
  headSha: string | null;
  commitCountTotal: number;
  timestamp: string;
}

/**
 * Snapshot of git state at a point in time. Used to detect "did anything
 * actually change" between iterations.
 */
export function snapshotRepo(repo: string): RepoMetrics {
  const isGit = existsSync(join(repo, '.git'));
  if (!isGit) {
    return { headSha: null, commitCountTotal: 0, timestamp: new Date().toISOString() };
  }
  return {
    headSha: git(repo, ['rev-parse', 'HEAD']) || null,
    commitCountTotal: Number(git(repo, ['rev-list', '--count', 'HEAD']) || '0'),
    timestamp: new Date().toISOString(),
  };
}

export function commitsBetween(repo: string, from: string | null, to: string | null): string[] {
  if (!existsSync(join(repo, '.git'))) return [];
  if (!to) return [];
  const range = from ? `${from}..${to}` : to;
  const out = git(repo, ['log', '--format=%H %s', range]);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

export function diffBetween(repo: string, from: string | null, to: string | null): string {
  if (!existsSync(join(repo, '.git'))) return '';
  if (!from || !to || from === to) return '';
  try {
    return execFileSync('git', ['-C', repo, 'diff', '--stat', '--no-color', `${from}..${to}`], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

export function fullDiffBetween(repo: string, from: string | null, to: string | null): string {
  if (!existsSync(join(repo, '.git'))) return '';
  if (!from || !to || from === to) return '';
  try {
    return execFileSync('git', ['-C', repo, 'diff', '--no-color', `${from}..${to}`], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * List repo-relative file paths that changed between two SHAs (one entry per
 * file, deduped, blank lines filtered). Returns [] if the range is empty or
 * the repo is not a git checkout. Used by the self-drive auto-relaunch path
 * to decide whether the latest worker commit shipped autopilot internals
 * that the running parent process won't pick up without a re-exec.
 */
export function changedPathsBetween(repo: string, from: string | null, to: string | null): string[] {
  if (!existsSync(join(repo, '.git'))) return [];
  if (!from || !to || from === to) return [];
  try {
    const out = execFileSync('git', ['-C', repo, 'diff', '--name-only', `${from}..${to}`], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return Array.from(new Set(out.split('\n').map((s) => s.trim()).filter(Boolean)));
  } catch {
    return [];
  }
}

/**
 * True when any of `changedPaths` is an autopilot internal that the running
 * parent process has cached in memory: source under `src/`, compiled output
 * under `dist/`, skill prompts under `skills/`, package metadata, or the
 * autopilot bin entry. These are exactly the files whose content reaches
 * the live loop only after a re-exec.
 */
export function touchesAutopilotInternals(changedPaths: string[]): boolean {
  return changedPaths.some(
    (p) =>
      p === 'package.json' ||
      p === 'package-lock.json' ||
      p.startsWith('src/') ||
      p.startsWith('dist/') ||
      p.startsWith('skills/') ||
      p.startsWith('bin/'),
  );
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Normalize an outstanding bullet so trivial rewordings don't look like
 * progress. Lowercase, strip leading markers, collapse whitespace.
 */
export function normalizeBullet(b: string): string {
  return b
    .toLowerCase()
    .replace(/^[\s\-*•>\d.)(]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 1 : inter / uni;
}

export interface IterationSnapshot {
  iter: number;
  outstanding: string[];
  outstandingSummary: string;
  headSha: string | null;
  commitCountTotal: number;
}

export interface StagnationResult {
  stagnant: boolean;
  reason?: string;
  recentSimilarities: number[];
  commitDeltas: number[];
}

/**
 * Stagnation fires when, for `threshold` consecutive iteration transitions:
 *   (a) outstanding set is ≥ 90% the same (Jaccard), AND
 *   (b) no new commits landed.
 * If either condition breaks on any transition, the streak resets.
 */
export function detectStagnation(
  history: IterationSnapshot[],
  threshold: number,
): StagnationResult {
  const sims: number[] = [];
  const deltas: number[] = [];
  if (history.length < threshold + 1) {
    return { stagnant: false, recentSimilarities: sims, commitDeltas: deltas };
  }
  const tail = history.slice(-(threshold + 1));
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1];
    const curr = tail[i];
    const a = new Set(prev.outstanding.map(normalizeBullet).filter(Boolean));
    const b = new Set(curr.outstanding.map(normalizeBullet).filter(Boolean));
    sims.push(jaccard(a, b));
    deltas.push(curr.commitCountTotal - prev.commitCountTotal);
  }
  const allStuck = sims.every((s) => s >= 0.9) && deltas.every((d) => d === 0);
  if (allStuck) {
    return {
      stagnant: true,
      reason: `${threshold} consecutive iterations with ≥90% identical outstanding lists and 0 new commits`,
      recentSimilarities: sims,
      commitDeltas: deltas,
    };
  }
  return { stagnant: false, recentSimilarities: sims, commitDeltas: deltas };
}
