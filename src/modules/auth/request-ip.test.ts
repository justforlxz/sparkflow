import { describe, expect, it } from "vitest";
import { clientIp } from "./request-ip";

function headersWith(values: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(values)) headers.set(key, value);
  return headers;
}

describe("限速键来源（AC-11-8）", () => {
  it("不信任代理时忽略客户端伪造的 x-forwarded-for", () => {
    const headers = headersWith({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" });

    expect(clientIp(headers, false)).toBe("direct");
    expect(clientIp(headers, false)).toBe(clientIp(headersWith({ "x-forwarded-for": "198.51.100.7" }), false));
  });

  it("信任代理时取 x-forwarded-for 第一段", () => {
    const headers = headersWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });

    expect(clientIp(headers, true)).toBe("203.0.113.9");
  });

  it("信任代理但缺少该头时退回 x-real-ip / direct", () => {
    expect(clientIp(headersWith({ "x-real-ip": "203.0.113.5" }), true)).toBe("203.0.113.5");
    expect(clientIp(headersWith({}), true)).toBe("direct");
  });
});
