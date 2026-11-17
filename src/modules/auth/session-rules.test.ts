import { describe, expect, it } from "vitest";
import { isSessionUsable } from "./session-rules";

const NOW = new Date("2026-11-17T12:00:00.000Z");

describe("会话可用性（AC-11-7）", () => {
  it("未撤销且未过期时可用", () => {
    expect(
      isSessionUsable({ expiresAt: new Date("2026-12-17T12:00:00.000Z"), revokedAt: null }, NOW),
    ).toBe(true);
  });

  it("过期后不可用", () => {
    expect(
      isSessionUsable({ expiresAt: new Date("2026-11-17T11:59:59.000Z"), revokedAt: null }, NOW),
    ).toBe(false);
  });

  it("正好到过期时刻即不可用", () => {
    expect(isSessionUsable({ expiresAt: NOW, revokedAt: null }, NOW)).toBe(false);
  });

  it("已撤销时即使未过期也不可用", () => {
    expect(
      isSessionUsable(
        { expiresAt: new Date("2026-12-17T12:00:00.000Z"), revokedAt: new Date("2026-11-17T11:00:00.000Z") },
        NOW,
      ),
    ).toBe(false);
  });
});
