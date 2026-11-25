import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isNavActive } from "./navigation";

/**
 * 侧栏导航登记表（docs/prd/09 MUST 1、AC-10-8）。
 * 文案与发布功能下线后只剩三项（ADR 0012 第 3 条、MKACG-976 AC-DEL-2）。
 */
describe("侧栏导航", () => {
  it("三个导航项与当前节点一致，顺序固定（发布记录随 ADR 0012 移除）", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "工作台",
      "媒体资源夹",
      "模型与 Agent 设置",
    ]);
  });

  it("三个导航项指向三个互不相同的路由", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(hrefs).toEqual(["/", "/collections", "/settings"]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("只有媒体资源夹带计数，且取自统计接口", () => {
    const badges = Object.fromEntries(NAV_ITEMS.map((item) => [item.key, item.badge]));
    expect(badges).toEqual({
      dashboard: null,
      collections: "collections",
      settings: null,
    });
  });

  it("当前项按路径判定：首页只匹配自己，其余匹配子路径", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/", "/collections")).toBe(false);
    expect(isNavActive("/collections", "/collections")).toBe(true);
    expect(isNavActive("/collections", "/collections/abc")).toBe(true);
    expect(isNavActive("/collections", "/settings")).toBe(false);
    // 前缀相同但不是子路径：不能高亮成别的项。
    expect(isNavActive("/collections", "/collectionsx")).toBe(false);
  });
});
