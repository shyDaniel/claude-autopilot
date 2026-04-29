import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type StatusPhase =
  | 'starting'
  | 'judging'
  | 'evaluating'
  | 'orchestrating'
  | 'working'
  | 'evolving'
  | 'idle'
  | 'stopped';

export interface StatusSnapshot {
  repo: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  iteration: number;
  phase: StatusPhase;
  currentAction?: string;
  lastVerdict?: {
    done: boolean;
    summary: string;
    outstandingCount: number;
    at: string;
  };
  stagnantIterations: number;
  stagnationThreshold: number;
  maxIterations: number | null;
  commitsSinceStart: number;
  stopReason?: 'done' | 'stagnant' | 'max_iterations' | 'error' | 'interrupted';
  stopMessage?: string;
}

const DIR = '.autopilot';
const FILE = 'status.json';

export class StatusWriter {
  private snap: StatusSnapshot;

  constructor(repo: string, init: Omit<StatusSnapshot, 'updatedAt'>) {
    this.snap = { ...init, updatedAt: new Date().toISOString() };
  }

  async update(patch: Partial<StatusSnapshot>): Promise<void> {
    this.snap = { ...this.snap, ...patch, updatedAt: new Date().toISOString() };
    await writeFileSafe(join(this.snap.repo, DIR, FILE), JSON.stringify(this.snap, null, 2));
  }

  get current(): StatusSnapshot {
    return this.snap;
  }
}

async function writeFileSafe(p: string, contents: string): Promise<void> {
  await mkdir(p.substring(0, p.lastIndexOf('/')), { recursive: true });
  await writeFile(p, contents, 'utf8');
}

export async function readStatus(repo: string): Promise<StatusSnapshot | null> {
  try {
    const raw = await readFile(join(repo, DIR, FILE), 'utf8');
    return JSON.parse(raw) as StatusSnapshot;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
