import { describe, expect, it } from "vitest";
import { safeNextPath } from "./redirect";

describe("登录跳转目标白名单（AC-11-5）", () => {
  it("保留站内相对路径与查询串", () => {
    expect(safeNextPath("/collections/abc?tab=raw")).toBe("/collections/abc?tab=raw");
    expect(safeNextPath("/settings")).toBe("/settings");
  });

  it("空值回首页", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });

  it("拒绝跨站与协议", () => {
    expect(safeNextPath("https://evil.example/phish")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("evil.example/path")).toBe("/");
  });

  it("拒绝路径里夹带的换行与反斜杠", () => {
    expect(safeNextPath("/\t/evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });
});
