import { resolve, join } from 'node:path';
import { existsSync, statSync, createReadStream } from 'node:fs';
import kleur from 'kleur';
import type { AutopilotEvent } from '../events.js';

const FILE = '.autopilot/events.jsonl';

export async function watchCommand(repoArg: string, opts: { since?: number }): Promise<number> {
  const repo = resolve(repoArg);
  const path = join(repo, FILE);

  console.log(kleur.bold().cyan(`watching ${path}`));
  console.log(kleur.gray('press Ctrl-C to stop'));
  console.log('');

  if (!existsSync(path)) {
    console.log(kleur.yellow('no events yet; waiting for file to appear…'));
    while (!existsSync(path)) await sleep(500);
  }

  let offset = 0;
  if (opts.since === undefined) {
    // Default: start from end (live tail), like `tail -f`.
    offset = statSync(path).size;
  } else {
    // Dump history first, then tail.
    await dumpFrom(path, 0, opts.since);
    offset = statSync(path).size;
  }

  let buffer = '';
  while (true) {
    const size = statSync(path).size;
    if (size < offset) {
      // file truncated — reset
      offset = 0;
      buffer = '';
    }
    if (size > offset) {
      const chunk = await readRange(path, offset, size);
      offset = size;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        printEvent(line);
      }
    }
    await sleep(400);
  }
}

async function dumpFrom(path: string, start: number, sinceIter: number): Promise<void> {
  const data = await readRange(path, start, statSync(path).size);
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AutopilotEvent;
      if (e.iter < sinceIter) continue;
      printEvent(line);
    } catch {
      // skip
    }
  }
}

function readRange(path: string, start: number, end: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const s = createReadStream(path, { start, end: Math.max(start, end - 1) });
    s.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    s.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    s.on('error', reject);
  });
}

function printEvent(line: string): void {
  let e: AutopilotEvent;
  try {
    e = JSON.parse(line) as AutopilotEvent;
  } catch {
    return;
  }
  const ts = kleur.gray(e.ts.slice(11, 19));
  const iter = kleur.bold(`#${String(e.iter).padStart(3, '0')}`);
  const phase = colorPhase(e.phase);
  const kind = colorKind(e.kind);
  const msg = e.msg ? ` ${e.msg}` : '';
  console.log(`${ts} ${iter} ${phase} ${kind}${msg}`);
}

function colorPhase(p: string): string {
  switch (p) {
    case 'loop':
      return kleur.cyan('loop  ');
    case 'judge':
      return kleur.blue('judge ');
    case 'worker':
      return kleur.magenta('worker');
    default:
      return p.padEnd(6);
  }
}

function colorKind(k: string): string {
  switch (k) {
    case 'start':
      return kleur.green('▶ start    ');
    case 'end':
      return kleur.green('■ end      ');
    case 'tool':
      return kleur.yellow('● tool     ');
    case 'text':
      return kleur.gray('  text     ');
    case 'verdict':
      return kleur.bold().cyan('✓ verdict  ');
    case 'error':
      return kleur.red('✗ error    ');
    case 'stagnation':
      return kleur.red().bold('! stagnant ');
    case 'commit':
      return kleur.green().bold('⧗ commit   ');
    default:
      return k.padEnd(11);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
