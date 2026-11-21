import { describe, expect, it } from "vitest";
import { activeVersions, formatVersionTime, isActiveVersion, titleFirstLine } from "./summary";

/** 文案版本列表的派生状态（发布页签：轮询条件、标题首行）。 */
describe("文案版本列表的派生状态", () => {
  it("queued / running 视为还在生成，其余是已结束", () => {
    expect(isActiveVersion("queued")).toBe(true);
    expect(isActiveVersion("running")).toBe(true);
    expect(isActiveVersion("succeeded")).toBe(false);
    expect(isActiveVersion("failed")).toBe(false);
  });

  it("只挑出还在生成的版本，保持传入顺序", () => {
    const versions = [
      { id: "v3", status: "running" },
      { id: "v2", status: "failed" },
      { id: "v1", status: "queued" },
    ];
    expect(activeVersions(versions).map((version) => version.id)).toEqual(["v3", "v1"]);
  });

  it("没有版本或全部结束时返回空数组", () => {
    expect(activeVersions([])).toEqual([]);
    expect(activeVersions([{ status: "succeeded" }, { status: "failed" }])).toEqual([]);
  });

  it("标题首行只取第一行并去掉首尾空白", () => {
    expect(titleFirstLine("  第一行标题  \n第二行正文")).toBe("第一行标题");
    expect(titleFirstLine("只有一行")).toBe("只有一行");
    expect(titleFirstLine("")).toBe("");
    expect(titleFirstLine(null)).toBe("");
  });

  it("首行是空行时不往下捞：列表只显示第一行", () => {
    expect(titleFirstLine("\n第二行才是标题")).toBe("");
  });
});

describe("版本列表的生成时间", () => {
  it("取 YYYY-MM-DD HH:mm，不做本地时区换算", () => {
    expect(formatVersionTime("2026-11-21T15:19:33.000Z")).toBe("2026-11-21 15:19");
  });
});
