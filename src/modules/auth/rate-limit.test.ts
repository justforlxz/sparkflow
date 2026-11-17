import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "./rate-limit";

const WINDOW = 5 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("登录失败限速（AC-11-8）", () => {
  it("前 5 次失败仍允许继续尝试，第 6 次被拒", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(limiter.check("1.2.3.4", NOW)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      limiter.recordFailure("1.2.3.4", NOW);
    }

    const decision = limiter.check("1.2.3.4", NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(WINDOW / 1000);
  });

  it("不同 IP 互不影响", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 1; attempt <= 5; attempt += 1) limiter.recordFailure("1.2.3.4", NOW);

    expect(limiter.check("5.6.7.8", NOW).allowed).toBe(true);
  });

  it("窗口期结束后重新计数", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 1; attempt <= 5; attempt += 1) limiter.recordFailure("1.2.3.4", NOW);

    expect(limiter.check("1.2.3.4", NOW + WINDOW + 1).allowed).toBe(true);
  });

  it("记录条数达到上限时清掉已过窗口的键，不会无界增长", () => {
    const limiter = new LoginRateLimiter(5, WINDOW, 2);
    limiter.recordFailure("1.2.3.4", NOW);
    limiter.recordFailure("5.6.7.8", NOW);
    expect(limiter.size).toBe(2);

    limiter.recordFailure("9.9.9.9", NOW + WINDOW + 1);

    expect(limiter.size).toBe(1);
    expect(limiter.check("1.2.3.4", NOW + WINDOW + 1).allowed).toBe(true);
  });

  it("登录成功后清零", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 1; attempt <= 5; attempt += 1) limiter.recordFailure("1.2.3.4", NOW);

    limiter.clear("1.2.3.4");
    expect(limiter.check("1.2.3.4", NOW).allowed).toBe(true);
  });
});
