import { resolve } from 'node:path';
import kleur from 'kleur';
import { readEvents } from '../events.js';

export async function logCommand(repoArg: string, opts: { since?: number; tail?: number }): Promise<number> {
  const repo = resolve(repoArg);
  const events = await readEvents(repo, { since: opts.since });
  if (events.length === 0) {
    console.log(kleur.yellow('no events found'));
    return 1;
  }

  const byIter = new Map<number, { tools: number; commits: number; verdict?: string; started?: string; ended?: string }>();
  for (const e of events) {
    if (e.iter === 0) continue;
    const row = byIter.get(e.iter) ?? { tools: 0, commits: 0 };
    if (e.kind === 'tool') row.tools += 1;
    if (e.kind === 'commit') row.commits += 1;
    if (e.kind === 'verdict') row.verdict = (e.data as { verdict?: { done?: boolean; outstanding?: string[] } })?.verdict?.done ? 'DONE' : `${(e.data as { verdict?: { outstanding?: string[] } })?.verdict?.outstanding?.length ?? '?'} outstanding`;
    if (e.phase === 'loop' && e.kind === 'start') row.started = e.ts;
    if (e.phase === 'loop' && e.kind === 'end') row.ended = e.ts;
    byIter.set(e.iter, row);
  }

  const iters = [...byIter.entries()].sort(([a], [b]) => a - b);
  const limited = opts.tail ? iters.slice(-opts.tail) : iters;

  console.log(kleur.bold('iter  started              ended                tools  commits  verdict'));
  console.log(kleur.gray('────  ───────────────────  ───────────────────  ─────  ───────  ──────────────'));
  for (const [iter, row] of limited) {
    const started = (row.started ?? '').slice(11, 19);
    const ended = (row.ended ?? '').slice(11, 19);
    const verdict = row.verdict === 'DONE' ? kleur.green('DONE') : row.verdict ?? kleur.gray('—');
    console.log(
      `${String(iter).padStart(4)}  ${started.padEnd(19)}  ${ended.padEnd(19)}  ${String(row.tools).padStart(5)}  ${String(row.commits).padStart(7)}  ${verdict}`,
    );
  }

  const loopStart = events.find((e) => e.phase === 'loop' && e.kind === 'start' && e.iter === 0);
  const loopEnd = [...events].reverse().find((e) => e.phase === 'loop' && e.kind === 'end' && e.iter !== 0) ?? [...events].reverse().find((e) => e.phase === 'loop' && e.kind === 'end');
  if (loopEnd?.msg) {
    console.log('');
    console.log(`stopped:  ${kleur.bold(loopEnd.msg)}`);
  }
  if (loopStart) {
    console.log(`started:  ${loopStart.ts}`);
  }

  return 0;
}
