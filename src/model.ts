export interface ModelPreference {
  primary: string;
  fallback: string;
}

export const DEFAULT_WORKER_MODELS: ModelPreference = {
  primary: 'claude-opus-4-7',
  fallback: 'claude-sonnet-4-6',
};

export const DEFAULT_JUDGE_MODELS: ModelPreference = {
  primary: 'claude-opus-4-7',
  fallback: 'claude-sonnet-4-6',
};

export type FallbackListener = (from: string, to: string, reason: string) => void | Promise<void>;

/**
 * Sticky downgrade: once we've seen a quota/rate-limit/overload error on the
 * primary model, stay on the fallback for the rest of this process. The
 * assumption is that the condition takes minutes-to-hours to clear and we'd
 * rather keep making progress than keep hitting the same ceiling.
 */
export class ModelSelector {
  private downgraded = false;

  constructor(
    private pref: ModelPreference,
    private label: 'worker' | 'judge',
    private onFallback?: FallbackListener,
  ) {}

  current(): string {
    return this.downgraded ? this.pref.fallback : this.pref.primary;
  }

  isDowngraded(): boolean {
    return this.downgraded;
  }

  primary(): string {
    return this.pref.primary;
  }

  fallback(): string {
    return this.pref.fallback;
  }

  getLabel(): 'worker' | 'judge' {
    return this.label;
  }

  async noteFailure(err: unknown): Promise<{ retry: boolean; reason: string }> {
    const msg = errorMessage(err);
    if (isQuotaLike(msg) && !this.downgraded) {
      const from = this.pref.primary;
      const to = this.pref.fallback;
      this.downgraded = true;
      if (this.onFallback) await this.onFallback(from, to, truncate(msg, 240));
      return { retry: true, reason: msg };
    }
    return { retry: false, reason: msg };
  }
}

const QUOTA_RE =
  /(rate[_\s-]?limit|rate_limited|overloaded|insufficient[_\s-]?quota|quota[_\s-]?exceeded|credit[_\s-]?balance|over_capacity|529|529\b|\b429\b|too many requests)/i;

export function isQuotaLike(msg: string): boolean {
  return QUOTA_RE.test(msg);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Run `fn(currentModel)`. On failure, if the selector judges it quota-like and
 * has a fallback it hasn't used yet, retry once with the fallback model.
 */
export async function withModel<T>(
  selector: ModelSelector,
  fn: (model: string) => Promise<T>,
): Promise<T> {
  try {
    return await fn(selector.current());
  } catch (err) {
    const { retry, reason } = await selector.noteFailure(err);
    if (retry) {
      const msg = `[${selector.getLabel()}] primary model hit "${reason.slice(0, 120)}…"; retrying on ${selector.current()}`;
      console.error(msg);
      return await fn(selector.current());
    }
    throw err;
  }
}
