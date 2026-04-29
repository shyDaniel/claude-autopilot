import { resolve } from 'node:path';
import kleur from 'kleur';
import { readEvents, type AutopilotEvent } from '../events.js';

interface IterRow {
  iter: number;
  tools: number;
  commits: number;
  verdict?: string;
  startedAt?: string; // ISO
  endedAt?: string; // ISO
}

interface Session {
  startedAt?: string;
  rows: Map<number, IterRow>;
  endMsg?: string;
}

/**
 * Split the event stream into sessions delimited by iter==0 loop start events
 * (each top-level autopilot invocation emits one). Events that arrive before
 * any session marker are placed in an implicit leading session so legacy
 * single-run logs still render. Iter-numbered events after a session marker
 * belong to that session, even if previous sessions used the same iter number.
 */
export function partitionSessions(events: AutopilotEvent[]): Session[] {
  const sessions: Session[] = [];
  let current: Session | undefined;

  for (const e of events) {
    const isSessionMarker = e.iter === 0 && e.phase === 'loop' && e.kind === 'start';
    if (isSessionMarker) {
      current = { startedAt: e.ts, rows: new Map() };
      sessions.push(current);
      continue;
    }
    if (!current) {
      current = { rows: new Map() };
      sessions.push(current);
    }
    if (e.iter === 0) {
      // Other iter==0 events (e.g. the loop kind=end recap) belong to the current session.
      if (e.phase === 'loop' && e.kind === 'end' && e.msg) current.endMsg = e.msg;
      continue;
    }
    const row = current.rows.get(e.iter) ?? { iter: e.iter, tools: 0, commits: 0 };
    if (e.kind === 'tool') row.tools += 1;
    if (e.kind === 'commit') row.commits += 1;
    if (e.kind === 'verdict') {
      const v = (e.data as { verdict?: { done?: boolean; outstanding?: string[] } } | undefined)?.verdict;
      if (v?.done) {
        row.verdict = 'DONE';
      } else if (Array.isArray(v?.outstanding)) {
        row.verdict = `${v.outstanding.length} outstanding`;
      } else {
        row.verdict = 'outstanding';
      }
    }
    if (e.phase === 'loop' && e.kind === 'start') {
      // First start wins so resumes/retries don't overwrite the original launch time.
      if (!row.startedAt) row.startedAt = e.ts;
    }
    if (e.phase === 'loop' && e.kind === 'end') {
      // Last end wins so the final completion timestamp is captured.
      row.endedAt = e.ts;
    }
    current.rows.set(e.iter, row);
  }

  return sessions;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTime(iso: string): string {
  // Render in the user's local timezone so the wall-clock matches what they see in `date`.
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDuration(startISO: string, endISO: string): string {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${pad2(m)}m`;
  if (m > 0) return `${m}m${pad2(s)}s`;
  return `${s}s`;
}

export interface RenderedRow {
  iter: number;
  started: string;
  duration: string;
  tools: number;
  commits: number;
  verdict: string;
}

export interface RenderedSession {
  rows: RenderedRow[];
  spansMultipleDays: boolean;
  startedAt?: string;
  endMsg?: string;
}

export function renderSession(session: Session): RenderedSession {
  // Sort rows by actual loop start timestamp. Iters without a recorded start fall back
  // to their iter-number position relative to neighbours so they don't all collapse to the top.
  const rows = [...session.rows.values()].sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : Number.POSITIVE_INFINITY;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.iter - b.iter;
  });

  const dates = new Set<string>();
  for (const r of rows) {
    if (r.startedAt) dates.add(formatDate(r.startedAt));
    if (r.endedAt) dates.add(formatDate(r.endedAt));
  }
  const spansMultipleDays = dates.size > 1;

  const rendered: RenderedRow[] = rows.map((r) => {
    const startedDisplay = r.startedAt
      ? spansMultipleDays
        ? `${formatDate(r.startedAt)} ${formatTime(r.startedAt)}`
        : formatTime(r.startedAt)
      : '—';
    const duration = r.startedAt && r.endedAt ? formatDuration(r.startedAt, r.endedAt) : r.startedAt ? 'running' : '—';
    return {
      iter: r.iter,
      started: startedDisplay,
      duration,
      tools: r.tools,
      commits: r.commits,
      verdict: r.verdict ?? '—',
    };
  });

  return { rows: rendered, spansMultipleDays, startedAt: session.startedAt, endMsg: session.endMsg };
}

export async function logCommand(
  repoArg: string,
  opts: { since?: number; tail?: number; all?: boolean },
): Promise<number> {
  const repo = resolve(repoArg);
  const events = await readEvents(repo, { since: opts.since });
  if (events.length === 0) {
    console.log(kleur.yellow('no events found'));
    return 1;
  }

  const sessions = partitionSessions(events);
  const visible = opts.all ? sessions : sessions.slice(-1);

  for (let i = 0; i < visible.length; i++) {
    const rendered = renderSession(visible[i]);
    let rows = rendered.rows;
    if (opts.tail) rows = rows.slice(-opts.tail);

    if (visible.length > 1) {
      const idx = sessions.indexOf(visible[i]) + 1;
      const startedLabel = rendered.startedAt ? ` started ${rendered.startedAt}` : '';
      console.log(kleur.bold(`session ${idx}/${sessions.length}${startedLabel}`));
    }

    const startedHeader = rendered.spansMultipleDays ? 'started               ' : 'started   ';
    const startedWidth = rendered.spansMultipleDays ? 21 : 9;
    console.log(
      kleur.bold(
        `iter  ${startedHeader.padEnd(startedWidth)}  duration  tools  commits  verdict`,
      ),
    );
    console.log(
      kleur.gray(
        `────  ${'─'.repeat(startedWidth)}  ────────  ─────  ───────  ──────────────`,
      ),
    );
    for (const r of rows) {
      const verdictColored = r.verdict === 'DONE' ? kleur.green('DONE') : r.verdict === '—' ? kleur.gray('—') : r.verdict;
      console.log(
        `${String(r.iter).padStart(4)}  ${r.started.padEnd(startedWidth)}  ${r.duration.padEnd(8)}  ${String(r.tools).padStart(5)}  ${String(r.commits).padStart(7)}  ${verdictColored}`,
      );
    }

    if (rendered.endMsg) {
      console.log('');
      console.log(`stopped:  ${kleur.bold(rendered.endMsg)}`);
    }
    if (rendered.startedAt) {
      console.log(`started:  ${rendered.startedAt}`);
    }
    if (i < visible.length - 1) console.log('');
  }

  return 0;
}
