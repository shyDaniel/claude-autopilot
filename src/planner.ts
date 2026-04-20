import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeBullet } from './metrics.js';

export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface StructuredSubtask {
  title?: string;
  files?: string[];
  symptom?: string;
  desired?: string;
  acceptance?: string;
}

export interface Subtask {
  id: string;
  text: string;
  normalizedKey: string;
  files?: string[];
  symptom?: string;
  desired?: string;
  acceptance?: string;
  status: SubtaskStatus;
  attempts: number;
  firstSeenIteration: number;
  lastAttemptIteration?: number;
  completedAtIteration?: number;
  failureReason?: string;
}

export interface Plan {
  version: 1;
  updatedAt: string;
  subtasks: Subtask[];
  lastWorkedOnId?: string;
}

const DIR = '.autopilot';
const FILE = 'plan.json';

export async function loadPlan(repo: string): Promise<Plan | null> {
  try {
    const raw = await readFile(join(repo, DIR, FILE), 'utf8');
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

export async function savePlan(repo: string, plan: Plan): Promise<void> {
  await mkdir(join(repo, DIR), { recursive: true });
  await writeFile(join(repo, DIR, FILE), JSON.stringify(plan, null, 2), 'utf8');
}

export function freshPlan(): Plan {
  return { version: 1, updatedAt: new Date().toISOString(), subtasks: [] };
}

function nextId(plan: Plan): string {
  const max = plan.subtasks
    .map((s) => Number(s.id.replace(/^S-/, '')))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `S-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Reconcile the current plan with the latest judge verdict.
 *
 * The judge's `outstanding` list is treated as ground truth for "what
 * still needs doing" at this iteration. The plan is the persistent ledger
 * that tracks attempt counts across iterations.
 *
 * - Outstanding items that match an existing subtask (by normalized key)
 *   stay. If that subtask was the `lastWorkedOnId` and it's still here,
 *   the worker's last attempt didn't clear it → bump `attempts`.
 * - Outstanding items with no match → append as new `pending` subtasks.
 * - Existing subtasks that are NOT in the new outstanding list → mark
 *   `completed` (the judge no longer sees them as blocking).
 * - `structuredSubtasks[i]` enriches `outstanding[i]` positionally if
 *   provided by the judge, giving us file paths / symptom / desired /
 *   acceptance — the self-contained brief the worker needs.
 */
export function reconcilePlan(
  prior: Plan | null,
  outstanding: string[],
  structured: StructuredSubtask[] | undefined,
  iteration: number,
  lastWorkedOnId?: string,
): Plan {
  const base: Plan = prior ? { ...prior, subtasks: prior.subtasks.map((s) => ({ ...s })) } : freshPlan();
  base.updatedAt = new Date().toISOString();

  const priorByKey = new Map(base.subtasks.map((s) => [s.normalizedKey, s]));
  const seenKeys = new Set<string>();

  const nextSubtasks: Subtask[] = [];
  for (let idx = 0; idx < outstanding.length; idx++) {
    const text = outstanding[idx]!;
    const key = normalizeBullet(text);
    if (!key) continue;
    const enrich = structured?.[idx];
    const existing = priorByKey.get(key);
    if (existing) {
      seenKeys.add(key);
      // Bump attempt if we just worked on this and judge still flags it.
      if (lastWorkedOnId && existing.id === lastWorkedOnId) {
        existing.attempts += 1;
        existing.lastAttemptIteration = iteration;
      }
      // Prefer fresh enrichment from the judge when provided.
      if (enrich) {
        if (enrich.files?.length) existing.files = enrich.files;
        if (enrich.symptom) existing.symptom = enrich.symptom;
        if (enrich.desired) existing.desired = enrich.desired;
        if (enrich.acceptance) existing.acceptance = enrich.acceptance;
      }
      // If it was 'in_progress' and still outstanding, flip back to pending.
      if (existing.status === 'in_progress') existing.status = 'pending';
      nextSubtasks.push(existing);
    } else {
      seenKeys.add(key);
      const fresh: Subtask = {
        id: nextId({ ...base, subtasks: [...base.subtasks, ...nextSubtasks] }),
        text,
        normalizedKey: key,
        files: enrich?.files,
        symptom: enrich?.symptom,
        desired: enrich?.desired,
        acceptance: enrich?.acceptance,
        status: 'pending',
        attempts: 0,
        firstSeenIteration: iteration,
      };
      nextSubtasks.push(fresh);
    }
  }

  // Any prior subtask NOT in the new outstanding list → completed.
  for (const prev of base.subtasks) {
    if (seenKeys.has(prev.normalizedKey)) continue;
    if (prev.status === 'failed') {
      nextSubtasks.push(prev); // preserve failed markers
      continue;
    }
    nextSubtasks.push({
      ...prev,
      status: 'completed',
      completedAtIteration: prev.completedAtIteration ?? iteration,
    });
  }

  return { ...base, subtasks: nextSubtasks };
}

/**
 * Pick the next subtask for the worker. Priority:
 *   1. status === 'pending', attempts < maxAttempts
 *   2. lowest attempts first (fairness — don't beat dead horses)
 *   3. oldest firstSeenIteration (FIFO)
 */
export function pickNextSubtask(plan: Plan, maxAttempts: number): Subtask | null {
  const eligible = plan.subtasks.filter(
    (s) => s.status === 'pending' && s.attempts < maxAttempts,
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.attempts !== b.attempts) return a.attempts - b.attempts;
    return a.firstSeenIteration - b.firstSeenIteration;
  });
  return eligible[0]!;
}

/**
 * Mark all pending subtasks that have hit the retry ceiling as `failed`.
 * Returns the ids that transitioned this call.
 */
export function markExhaustedAsFailed(plan: Plan, maxAttempts: number): string[] {
  const transitioned: string[] = [];
  for (const s of plan.subtasks) {
    if (s.status === 'pending' && s.attempts >= maxAttempts) {
      s.status = 'failed';
      s.failureReason = `exceeded max attempts (${maxAttempts})`;
      transitioned.push(s.id);
    }
  }
  return transitioned;
}

/**
 * Summary counts for logging + email bodies.
 */
export function planSummary(plan: Plan): {
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  total: number;
} {
  const counts = { pending: 0, in_progress: 0, completed: 0, failed: 0, total: plan.subtasks.length };
  for (const s of plan.subtasks) counts[s.status] += 1;
  return counts;
}

/**
 * Render a self-contained prompt section describing exactly one subtask
 * the worker should tackle. The worker MUST NOT need to re-discover this.
 */
export function renderSubtaskBrief(sub: Subtask): string {
  const lines: string[] = [];
  lines.push(`## THIS ITERATION'S SUBTASK  [id=${sub.id}, attempt ${sub.attempts + 1}]`);
  lines.push('');
  lines.push(`**Title:** ${sub.text}`);
  if (sub.files?.length) {
    lines.push('');
    lines.push('**Files to focus on:**');
    for (const f of sub.files) lines.push(`- \`${f}\``);
  }
  if (sub.symptom) {
    lines.push('');
    lines.push(`**Symptom:** ${sub.symptom}`);
  }
  if (sub.desired) {
    lines.push('');
    lines.push(`**Desired behavior:** ${sub.desired}`);
  }
  if (sub.acceptance) {
    lines.push('');
    lines.push(`**Acceptance test:** ${sub.acceptance}`);
  }
  if (sub.attempts > 0) {
    lines.push('');
    lines.push(
      `⚠ Previous attempts did not clear this subtask (attempt count: ${sub.attempts}). ` +
        `Do NOT repeat the same approach — diagnose what the last attempt missed, using ` +
        `\`.autopilot/iterations/NNN/worker-transcript.md\` artifacts if useful.`,
    );
  }
  lines.push('');
  lines.push(
    'This brief is self-contained. You do NOT need to re-scan the whole repo to pick work — focus on the files above and finish this ONE subtask end-to-end.',
  );
  return lines.join('\n');
}
