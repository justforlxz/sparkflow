/**
 * 登录失败限速（AC-11-8）：同一 IP 在窗口期内失败达到上限后拒绝继续尝试。
 * 进程内计数即可 —— 本项目单进程部署，重启后计数清零可以接受。
 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 5 * 60 * 1000,
    /** 记录上限：超过时先清掉已过窗口的条目，避免键无界增长。 */
    private readonly maxEntries = 1000,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry) this.attempts.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (entry.count < this.limit) return { allowed: true, retryAfterSeconds: 0 };

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  recordFailure(key: string, now: number = Date.now()): void {
    if (this.attempts.size >= this.maxEntries) this.prune(now);

    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  /** 测试用：当前记录条数。 */
  get size(): number {
    return this.attempts.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.attempts) {
      if (entry.resetAt <= now) this.attempts.delete(key);
    }
  }
}

export const loginRateLimiter = new LoginRateLimiter();
