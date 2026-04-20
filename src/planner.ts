import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeBullet } from './metrics.js';

export type SubtaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  /** Hit attempt ceiling — next judge iteration must decompose/reframe/block. */
  | 'needs_reframe'
  /** Superseded by a child subtask (decomposition or reframing). */
  | 'reframed'
  /** Genuinely impossible to code-fix (judge marked it). */
  | 'blocked'
  /** Exhausted retries even after reframing. */
  | 'failed';

export interface StructuredSubtask {
  title?: string;
  files?: string[];
  symptom?: string;
  desired?: string;
  acceptance?: string;
  /** Judge's signal: this subtask replaces/decomposes a stuck one. */
  reframedFrom?: string;
  blocked?: boolean;
  blockedReason?: string;
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
  /** The parent subtask id this one was reframed/decomposed from. */
  reframedFrom?: string;
  /** Generation — original subtasks have depth 0, reframes add 1. */
  reframeDepth: number;
  /** Populated when status === 'blocked'. */
  blockedReason?: string;
}

/** How many times a lineage can be reframed before we give up for real. */
export const MAX_REFRAME_DEPTH = 2;

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

  const priorById = new Map(base.subtasks.map((s) => [s.id, s]));
  const priorByKey = new Map(base.subtasks.map((s) => [s.normalizedKey, s]));
  const seenKeys = new Set<string>();
  const reframedParentIds = new Set<string>();

  const nextSubtasks: Subtask[] = [];
  for (let idx = 0; idx < outstanding.length; idx++) {
    const text = outstanding[idx]!;
    const key = normalizeBullet(text);
    if (!key) continue;
    const enrich = structured?.[idx];

    // Case A: judge is replacing/decomposing a stuck parent.
    if (enrich?.reframedFrom) {
      const parent = priorById.get(enrich.reframedFrom);
      if (parent) {
        reframedParentIds.add(parent.id);
        const depth = parent.reframeDepth + 1;
        const exceedsDepth = depth > MAX_REFRAME_DEPTH;
        const blocked = Boolean(enrich.blocked);
        const child: Subtask = {
          id: nextId({ ...base, subtasks: [...base.subtasks, ...nextSubtasks] }),
          text,
          normalizedKey: key,
          files: enrich.files,
          symptom: enrich.symptom,
          desired: enrich.desired,
          acceptance: enrich.acceptance,
          status: blocked ? 'blocked' : exceedsDepth ? 'failed' : 'pending',
          attempts: 0,
          firstSeenIteration: iteration,
          reframedFrom: parent.id,
          reframeDepth: depth,
          blockedReason: blocked ? (enrich.blockedReason ?? 'marked blocked by judge') : undefined,
          failureReason: exceedsDepth ? `max reframe depth (${MAX_REFRAME_DEPTH}) exceeded` : undefined,
        };
        seenKeys.add(key);
        nextSubtasks.push(child);
        continue;
      }
      // parent not found → fall through to normal handling
    }

    // Case B: normal flow — match by normalized key.
    const existing = priorByKey.get(key);
    if (existing) {
      seenKeys.add(key);
      if (lastWorkedOnId && existing.id === lastWorkedOnId) {
        existing.attempts += 1;
        existing.lastAttemptIteration = iteration;
      }
      if (enrich) {
        if (enrich.files?.length) existing.files = enrich.files;
        if (enrich.symptom) existing.symptom = enrich.symptom;
        if (enrich.desired) existing.desired = enrich.desired;
        if (enrich.acceptance) existing.acceptance = enrich.acceptance;
        if (enrich.blocked) {
          existing.status = 'blocked';
          existing.blockedReason = enrich.blockedReason ?? 'marked blocked by judge';
        }
      }
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
        status: enrich?.blocked ? 'blocked' : 'pending',
        attempts: 0,
        firstSeenIteration: iteration,
        reframeDepth: 0,
        blockedReason: enrich?.blocked ? (enrich.blockedReason ?? 'marked blocked by judge') : undefined,
      };
      nextSubtasks.push(fresh);
    }
  }

  // Carry forward prior subtasks that didn't match anything this round.
  for (const prev of base.subtasks) {
    if (seenKeys.has(prev.normalizedKey)) continue;
    if (reframedParentIds.has(prev.id)) {
      // Stuck parent: judge replaced it. Mark as reframed, retain as history.
      nextSubtasks.push({ ...prev, status: 'reframed' });
      continue;
    }
    // Terminal statuses carry over as-is.
    if (prev.status === 'failed' || prev.status === 'reframed' || prev.status === 'blocked') {
      nextSubtasks.push(prev);
      continue;
    }
    // Otherwise, judge no longer flags it → completed.
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
 * Flip pending subtasks that have hit the retry ceiling into
 * `needs_reframe`. The next judge iteration is expected to decompose,
 * reframe, or mark them blocked — NOT just leave them stuck. Real `failed`
 * status only occurs when MAX_REFRAME_DEPTH is exceeded.
 */
export function markExhaustedAsNeedsReframe(plan: Plan, maxAttempts: number): string[] {
  const transitioned: string[] = [];
  for (const s of plan.subtasks) {
    if (s.status === 'pending' && s.attempts >= maxAttempts) {
      s.status = 'needs_reframe';
      transitioned.push(s.id);
    }
  }
  return transitioned;
}

/**
 * Subtasks the judge needs to reframe this iteration. Returned with a
 * compact reference block the judge prompt can drop in verbatim.
 */
export function collectStuckSubtasks(plan: Plan): Subtask[] {
  return plan.subtasks.filter((s) => s.status === 'needs_reframe');
}

export function renderStuckBrief(stuck: Subtask[]): string {
  if (stuck.length === 0) return '';
  const lines: string[] = [];
  lines.push('## STUCK SUBTASKS — you MUST reframe, decompose, or block each of these');
  lines.push('');
  lines.push(
    `The worker has tried each of these ${stuck.length} subtask${stuck.length === 1 ? '' : 's'} ` +
      `the maximum number of times without clearing them. Walking away is NOT ` +
      `acceptable. For each stuck subtask, your verdict's \`subtasks\` array MUST ` +
      `include one or more NEW entries with \`reframedFrom: "<stuck_id>"\` that ` +
      `EITHER (a) decompose it into 2–3 smaller subtasks with sharper files / ` +
      `symptom / desired / acceptance, OR (b) reframe it as a single subtask ` +
      `with different framing, OR (c) mark it \`blocked: true\` with a concrete ` +
      `\`blockedReason\` (only if a code fix is genuinely impossible, e.g. ` +
      `requires a human with external account access).`,
  );
  lines.push('');
  for (const s of stuck) {
    lines.push(`- **${s.id}** (attempts: ${s.attempts}, reframeDepth: ${s.reframeDepth}):`);
    lines.push(`    text: ${s.text}`);
    if (s.files?.length) lines.push(`    files: ${s.files.join(', ')}`);
    if (s.symptom) lines.push(`    symptom: ${s.symptom}`);
    if (s.desired) lines.push(`    desired: ${s.desired}`);
    if (s.acceptance) lines.push(`    acceptance: ${s.acceptance}`);
    if (s.lastAttemptIteration) {
      lines.push(
        `    last attempted: iteration ${s.lastAttemptIteration} ` +
          `(transcript: .autopilot/iterations/${String(s.lastAttemptIteration).padStart(6, '0')}/worker-transcript.md)`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Summary counts for logging + email bodies.
 */
export function planSummary(plan: Plan): {
  pending: number;
  in_progress: number;
  completed: number;
  needs_reframe: number;
  reframed: number;
  blocked: number;
  failed: number;
  total: number;
} {
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    needs_reframe: 0,
    reframed: 0,
    blocked: 0,
    failed: 0,
    total: plan.subtasks.length,
  };
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
