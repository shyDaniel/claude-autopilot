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
}

const DIR = '.autopilot';
const FILE = 'state.json';

export async function loadState(repo: string): Promise<AutopilotState | null> {
  try {
    const raw = await readFile(join(repo, DIR, FILE), 'utf8');
    return JSON.parse(raw) as AutopilotState;
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
  };
}
