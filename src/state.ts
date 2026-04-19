import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AutopilotState {
  iteration: number;
  startedAt: string;
  lastVerdict?: {
    done: boolean;
    summary: string;
    outstanding: string[];
    at: string;
  };
  errors: { at: string; message: string }[];
  refinementsSoFar: number;
}

const DIR = '.autopilot';
const FILE = 'state.json';

export async function loadState(repo: string): Promise<AutopilotState | null> {
  try {
    const raw = await readFile(join(repo, DIR, FILE), 'utf8');
    return hydrateState(JSON.parse(raw) as Partial<AutopilotState>);
  } catch {
    return null;
  }
}

export async function saveState(repo: string, state: AutopilotState): Promise<void> {
  const dir = join(repo, DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE), JSON.stringify(state, null, 2), 'utf8');
}

export function freshState(): AutopilotState {
  return {
    iteration: 0,
    startedAt: new Date().toISOString(),
    errors: [],
    refinementsSoFar: 0,
  };
}

export function hydrateState(raw: Partial<AutopilotState>): AutopilotState {
  const fresh = freshState();
  return {
    ...fresh,
    ...raw,
    errors: raw.errors ?? fresh.errors,
    refinementsSoFar: raw.refinementsSoFar ?? 0,
  };
}
