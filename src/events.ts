import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type EventPhase = 'loop' | 'judge' | 'worker' | 'eval' | 'orchestrate';

export type EventKind =
  | 'start'
  | 'end'
  | 'tool'
  | 'text'
  | 'verdict'
  | 'error'
  | 'stagnation'
  | 'commit'
  | 'heartbeat'
  | 'self-relaunch';

export interface AutopilotEvent {
  ts: string;
  iter: number;
  phase: EventPhase;
  kind: EventKind;
  msg?: string;
  data?: Record<string, unknown>;
}

const DIR = '.autopilot';
const FILE = 'events.jsonl';

export class EventLog {
  private ready = false;

  constructor(private readonly repo: string) {}

  async ensureDir(): Promise<void> {
    if (this.ready) return;
    await mkdir(join(this.repo, DIR), { recursive: true });
    this.ready = true;
  }

  async emit(evt: Omit<AutopilotEvent, 'ts'>): Promise<void> {
    await this.ensureDir();
    const full: AutopilotEvent = { ts: new Date().toISOString(), ...evt };
    const line = JSON.stringify(full) + '\n';
    await appendFile(join(this.repo, DIR, FILE), line, 'utf8');
  }

  path(): string {
    return join(this.repo, DIR, FILE);
  }
}

export async function readEvents(repo: string, opts?: { since?: number }): Promise<AutopilotEvent[]> {
  const p = join(repo, DIR, FILE);
  let raw = '';
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return [];
  }
  const out: AutopilotEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AutopilotEvent;
      if (opts?.since !== undefined && e.iter < opts.since) continue;
      out.push(e);
    } catch {
      // skip malformed line
    }
  }
  return out;
}
