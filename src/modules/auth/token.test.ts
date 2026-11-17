import { describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken } from "./token";

describe("会话令牌", () => {
  it("生成 32 字节的 base64url 令牌", () => {
    const token = createSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSessionToken()).not.toBe(token);
  });

  it("库里存的哈希与令牌原文不同，且同一令牌哈希稳定", () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);

    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
  });
});
