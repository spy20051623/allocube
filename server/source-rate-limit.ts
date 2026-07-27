export type SourceRateLimitPolicy = {
  max: number;
  windowMs: number;
};

type WindowState = {
  count: number;
  resetAt: number;
};

export type SourceRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class SourceRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private operations = 0;

  constructor(private readonly maxKeys = 50_000) {}

  check(
    key: string,
    policy: SourceRateLimitPolicy,
    now = Date.now()
  ): SourceRateLimitResult {
    this.operations += 1;
    if (this.operations % 1_000 === 0) {
      this.removeExpired(now);
    }

    const current = this.windows.get(key);
    if (current && current.resetAt > now) {
      if (current.count >= policy.max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((current.resetAt - now) / 1_000)
          )
        };
      }
      current.count += 1;
      return { allowed: true };
    }

    if (!current && this.windows.size >= this.maxKeys) {
      this.removeExpired(now);
      if (this.windows.size >= this.maxKeys) {
        return { allowed: false, retryAfterSeconds: 60 };
      }
    }

    this.windows.set(key, {
      count: 1,
      resetAt: now + policy.windowMs
    });
    return { allowed: true };
  }

  private removeExpired(now: number) {
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}
