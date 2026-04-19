import { describe, it, expect, vi } from 'vitest';
import { ModelSelector, isQuotaLike, withModel } from '../src/model.js';

describe('isQuotaLike', () => {
  it.each([
    'Error: 429 Too Many Requests',
    'rate_limit_error: please slow down',
    'anthropic.overloaded_error: model capacity exceeded',
    'insufficient_quota: you have run out of credits',
    'HTTP 529 from upstream',
    'rate-limited on claude-opus-4-7',
    'credit_balance_too_low',
  ])('classifies %j as quota-like', (msg) => {
    expect(isQuotaLike(msg)).toBe(true);
  });

  it.each([
    'syntax error in prompt',
    'connection reset',
    'tool Bash returned non-zero',
    '500 Internal Server Error',
  ])('classifies %j as NOT quota-like', (msg) => {
    expect(isQuotaLike(msg)).toBe(false);
  });
});

describe('ModelSelector', () => {
  const pref = { primary: 'claude-opus-4-7', fallback: 'claude-sonnet-4-6' };

  it('starts on primary', () => {
    const s = new ModelSelector(pref, 'worker');
    expect(s.current()).toBe('claude-opus-4-7');
    expect(s.isDowngraded()).toBe(false);
  });

  it('downgrades exactly once on quota error, then sticks', async () => {
    const onFallback = vi.fn();
    const s = new ModelSelector(pref, 'worker', onFallback);

    let r = await s.noteFailure(new Error('429 rate_limit_error'));
    expect(r.retry).toBe(true);
    expect(s.current()).toBe('claude-sonnet-4-6');
    expect(onFallback).toHaveBeenCalledTimes(1);

    // Second quota error: already downgraded, do not retry again.
    r = await s.noteFailure(new Error('overloaded_error'));
    expect(r.retry).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('does NOT downgrade on non-quota errors', async () => {
    const s = new ModelSelector(pref, 'worker');
    const r = await s.noteFailure(new Error('some random error'));
    expect(r.retry).toBe(false);
    expect(s.current()).toBe('claude-opus-4-7');
  });
});

describe('withModel', () => {
  const pref = { primary: 'claude-opus-4-7', fallback: 'claude-sonnet-4-6' };

  it('returns the result when the first call succeeds', async () => {
    const s = new ModelSelector(pref, 'worker');
    const fn = vi.fn(async (m: string) => `ok:${m}`);
    const out = await withModel(s, fn);
    expect(out).toBe('ok:claude-opus-4-7');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with fallback model on quota error', async () => {
    const s = new ModelSelector(pref, 'worker');
    let attempt = 0;
    const fn = vi.fn(async (m: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('rate_limit_error');
      return `ok:${m}`;
    });
    const out = await withModel(s, fn);
    expect(out).toBe('ok:claude-sonnet-4-6');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(s.isDowngraded()).toBe(true);
  });

  it('rethrows non-quota errors without retry', async () => {
    const s = new ModelSelector(pref, 'worker');
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withModel(s, fn)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('only retries once even if fallback also fails', async () => {
    const s = new ModelSelector(pref, 'worker');
    const fn = vi.fn(async () => {
      throw new Error('rate_limit_error');
    });
    await expect(withModel(s, fn)).rejects.toThrow('rate_limit_error');
    // primary call + one fallback retry = 2; no third attempt
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
