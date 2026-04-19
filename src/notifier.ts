import nodemailer, { type Transporter } from 'nodemailer';
import { log } from './logging.js';

export interface NotifierConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string;
}

/**
 * Reads the same env vars as news-alerter's smtp_mailer.py:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM, EMAIL_TO
 * Enabled only when user+password are set AND --no-email wasn't passed.
 */
export function loadNotifierConfig(disabled: boolean): NotifierConfig {
  const user = process.env.SMTP_USER ?? '';
  const password = process.env.SMTP_PASSWORD ?? '';
  return {
    enabled: !disabled && Boolean(user && password),
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? '587'),
    user,
    password,
    from: process.env.EMAIL_FROM || user,
    to: process.env.EMAIL_TO || user,
  };
}

export type AlertKind = 'done' | 'big-progress' | 'self-refined' | 'needs-attention';

export interface BigProgressState {
  baseline: number | null; // most recent alert-triggering outstanding count, or first-seen count
  prev: number | null;     // previous iteration's outstanding count
}

export interface BigProgressResult {
  alert: boolean;
  reason?: 'halving' | 'one-shot';
  from: number;
  to: number;
}

/**
 * Pure: decides whether the current verdict represents "big" progress worth
 * emailing about. Returns alert=true if either:
 *   (a) one-shot drop: prev - current >= 5 items
 *   (b) cumulative halving: current <= baseline / 2 AND baseline - current >= 3
 * After an alert, caller should set state.baseline = current.
 */
export function evaluateBigProgress(
  state: BigProgressState,
  currentOutstanding: number,
): BigProgressResult {
  const prev = state.prev;
  const baseline = state.baseline;

  // One-shot drop wins if it's large.
  if (prev !== null && prev - currentOutstanding >= 5) {
    return { alert: true, reason: 'one-shot', from: prev, to: currentOutstanding };
  }

  if (baseline !== null && currentOutstanding <= baseline / 2 && baseline - currentOutstanding >= 3) {
    return { alert: true, reason: 'halving', from: baseline, to: currentOutstanding };
  }

  return { alert: false, from: baseline ?? prev ?? currentOutstanding, to: currentOutstanding };
}

export class Notifier {
  private transporter: Transporter | null = null;
  private lastByKind = new Map<AlertKind, number>();

  constructor(
    private cfg: NotifierConfig,
    private throttleMs = 10 * 60 * 1000,
  ) {
    if (cfg.enabled) {
      this.transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: false,
        requireTLS: true,
        auth: { user: cfg.user, pass: cfg.password },
      });
    }
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  async send(kind: AlertKind, subject: string, body: string): Promise<boolean> {
    if (!this.cfg.enabled || !this.transporter) return false;
    const now = Date.now();
    const last = this.lastByKind.get(kind) ?? 0;
    if (now - last < this.throttleMs) {
      log.dim(`email: throttled '${kind}' (last sent ${Math.round((now - last) / 1000)}s ago)`);
      return false;
    }
    try {
      await this.transporter.sendMail({
        from: this.cfg.from,
        to: this.cfg.to,
        subject,
        text: body,
      });
      this.lastByKind.set(kind, now);
      log.ok(`email: sent '${kind}' → ${this.cfg.to}`);
      return true;
    } catch (err) {
      log.warn(`email failed (${kind}): ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Bypass throttling. Used for terminal events (done, needs-attention) that
   * must always be delivered — they fire at most once per process anyway.
   */
  async sendImmediate(kind: AlertKind, subject: string, body: string): Promise<boolean> {
    if (!this.cfg.enabled || !this.transporter) return false;
    try {
      await this.transporter.sendMail({
        from: this.cfg.from,
        to: this.cfg.to,
        subject,
        text: body,
      });
      this.lastByKind.set(kind, Date.now());
      log.ok(`email: sent '${kind}' → ${this.cfg.to}`);
      return true;
    } catch (err) {
      log.warn(`email failed (${kind}): ${(err as Error).message}`);
      return false;
    }
  }
}
