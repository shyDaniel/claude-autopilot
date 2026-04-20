import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/finalReport.js';

describe('formatDuration', () => {
  it('seconds only', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('minutes + seconds', () => {
    expect(formatDuration(60_000)).toBe('1m 00s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(59 * 60_000 + 30_000)).toBe('59m 30s');
  });

  it('hours + minutes', () => {
    expect(formatDuration(3600_000)).toBe('1h 00m');
    expect(formatDuration(5 * 3600_000 + 2 * 60_000)).toBe('5h 02m');
    expect(formatDuration(10 * 3600_000)).toBe('10h 00m');
  });

  it('handles negative inputs gracefully', () => {
    expect(formatDuration(-1)).toBe('0s');
  });
});
