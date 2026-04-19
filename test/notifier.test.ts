import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  evaluateBigProgress,
  loadNotifierConfig,
  type BigProgressState,
} from '../src/notifier.js';

describe('evaluateBigProgress', () => {
  it('does not alert on the very first observation', () => {
    const state: BigProgressState = { baseline: null, prev: null };
    const r = evaluateBigProgress(state, 10);
    expect(r.alert).toBe(false);
  });

  it('alerts on one-shot drops of >= 5', () => {
    const state: BigProgressState = { baseline: 12, prev: 12 };
    const r = evaluateBigProgress(state, 7);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('one-shot');
    expect(r.from).toBe(12);
    expect(r.to).toBe(7);
  });

  it('does NOT alert on one-shot drops of < 5', () => {
    const state: BigProgressState = { baseline: 12, prev: 12 };
    expect(evaluateBigProgress(state, 8).alert).toBe(false);
    expect(evaluateBigProgress(state, 9).alert).toBe(false);
  });

  it('alerts when current <= baseline/2 AND baseline - current >= 3', () => {
    const state: BigProgressState = { baseline: 10, prev: 8 };
    // 10 → 4: halving (10/2 = 5, 4 ≤ 5, and 10 - 4 = 6 ≥ 3)
    const r = evaluateBigProgress(state, 4);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('halving');
  });

  it('does NOT alert on halving when absolute delta < 3', () => {
    const state: BigProgressState = { baseline: 4, prev: 4 };
    // 4 → 2: halving, but delta of 2 is below the floor
    expect(evaluateBigProgress(state, 2).alert).toBe(false);
  });

  it('does NOT alert on sub-halving drops', () => {
    const state: BigProgressState = { baseline: 10, prev: 9 };
    // 10 → 6: not halved (10/2=5, 6 > 5)
    expect(evaluateBigProgress(state, 6).alert).toBe(false);
  });

  it('does NOT alert when outstanding grows', () => {
    const state: BigProgressState = { baseline: 5, prev: 5 };
    expect(evaluateBigProgress(state, 8).alert).toBe(false);
  });

  it('prefers one-shot reason when both triggers fire', () => {
    const state: BigProgressState = { baseline: 10, prev: 10 };
    // 10 → 4: one-shot drop = 6, also halving
    const r = evaluateBigProgress(state, 4);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('one-shot');
  });
});

describe('loadNotifierConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_TO;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('is disabled when SMTP creds are missing', () => {
    const cfg = loadNotifierConfig(false);
    expect(cfg.enabled).toBe(false);
  });

  it('is enabled when SMTP_USER + SMTP_PASSWORD are set', () => {
    process.env.SMTP_USER = 'a@b.com';
    process.env.SMTP_PASSWORD = 'pw';
    const cfg = loadNotifierConfig(false);
    expect(cfg.enabled).toBe(true);
    expect(cfg.host).toBe('smtp.gmail.com');
    expect(cfg.port).toBe(587);
    expect(cfg.from).toBe('a@b.com');
    expect(cfg.to).toBe('a@b.com');
  });

  it('respects the CLI disable flag even when creds are set', () => {
    process.env.SMTP_USER = 'a@b.com';
    process.env.SMTP_PASSWORD = 'pw';
    expect(loadNotifierConfig(true).enabled).toBe(false);
  });

  it('uses EMAIL_FROM and EMAIL_TO overrides when provided', () => {
    process.env.SMTP_USER = 'a@b.com';
    process.env.SMTP_PASSWORD = 'pw';
    process.env.EMAIL_FROM = 'from@x.com';
    process.env.EMAIL_TO = 'to@y.com';
    const cfg = loadNotifierConfig(false);
    expect(cfg.from).toBe('from@x.com');
    expect(cfg.to).toBe('to@y.com');
  });
});
