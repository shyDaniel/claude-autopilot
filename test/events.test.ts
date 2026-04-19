import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, readEvents } from '../src/events.js';

describe('EventLog', () => {
  it('writes JSONL and round-trips via readEvents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autopilot-test-'));
    const log = new EventLog(dir);
    await log.emit({ iter: 1, phase: 'loop', kind: 'start', msg: 'hello' });
    await log.emit({ iter: 2, phase: 'worker', kind: 'tool', msg: 'Bash', data: { command: 'ls' } });

    const raw = await readFile(log.path(), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);

    const events = await readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0].msg).toBe('hello');
    expect(events[1].data).toEqual({ command: 'ls' });
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('filters by --since iteration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autopilot-test-'));
    const log = new EventLog(dir);
    for (let i = 1; i <= 5; i++) {
      await log.emit({ iter: i, phase: 'loop', kind: 'start' });
    }
    const events = await readEvents(dir, { since: 3 });
    expect(events.map((e) => e.iter)).toEqual([3, 4, 5]);
  });

  it('returns empty array when no log file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autopilot-test-'));
    expect(await readEvents(dir)).toEqual([]);
  });
});
