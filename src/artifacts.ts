import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Verdict } from './judge.js';
import { commitsBetween, diffBetween, fullDiffBetween, type RepoMetrics } from './metrics.js';

export interface IterationArtifacts {
  iter: number;
  verdict: Verdict;
  workerTranscript: string;
  before: RepoMetrics;
  after: RepoMetrics;
  durationMs: number;
}

const DIR = '.autopilot';

export async function writeIterationArtifacts(repo: string, a: IterationArtifacts): Promise<string> {
  const iterDir = join(repo, DIR, 'iterations', String(a.iter).padStart(6, '0'));
  await mkdir(iterDir, { recursive: true });

  const commits = commitsBetween(repo, a.before.headSha, a.after.headSha);
  const stat = diffBetween(repo, a.before.headSha, a.after.headSha);
  const diff = fullDiffBetween(repo, a.before.headSha, a.after.headSha);

  const metrics = {
    iter: a.iter,
    durationMs: a.durationMs,
    before: a.before,
    after: a.after,
    commitsAdded: commits.length,
    outstandingCount: a.verdict.outstanding.length,
    done: a.verdict.done,
  };

  await Promise.all([
    writeFile(join(iterDir, 'verdict.json'), JSON.stringify(a.verdict, null, 2), 'utf8'),
    writeFile(join(iterDir, 'worker-transcript.md'), a.workerTranscript || '(empty)', 'utf8'),
    writeFile(join(iterDir, 'commits.txt'), commits.join('\n') + (commits.length ? '\n' : ''), 'utf8'),
    writeFile(join(iterDir, 'diff.stat'), stat, 'utf8'),
    writeFile(join(iterDir, 'diff.patch'), diff, 'utf8'),
    writeFile(join(iterDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8'),
  ]);
  return iterDir;
}

export async function writeStagnationReport(
  repo: string,
  body: string,
): Promise<string> {
  const p = join(repo, DIR, 'STAGNATION_REPORT.md');
  await mkdir(join(repo, DIR), { recursive: true });
  await writeFile(p, body, 'utf8');
  return p;
}
