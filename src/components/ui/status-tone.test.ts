import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPY_VERSION_STATUSES } from "@/modules/copy-generation/constants";
import { EXTRACTION_STATUSES } from "@/modules/extraction/constants";
import { COLLECTION_STATUSES } from "@/modules/media-collection/constants";
import {
  COLLECTION_STATUS_TONE,
  COPY_VERSION_STATUS_TONE,
  EXTRACTION_STATUS_TONE,
} from "./status-tone";

/**
 * 状态标签颜色语义（docs/prd/09 SHOULD、AC-10-9）：
 * 待处理=蓝、生成中=强调色、待发布=橙、已发布=绿，颜色只来自 `globals.css` 的设计变量。
 */
const GLOBALS_CSS = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

describe("状态标签的颜色语义", () => {
  it("资源夹四种状态各自对应固定语义", () => {
    expect(COLLECTION_STATUS_TONE).toEqual({
      draft: "draft",
      generating: "generating",
      has_results: "pendingPublish",
      published: "published",
    });
  });

  it("提取运行与文案版本状态都有色板，不漏项", () => {
    expect(Object.keys(EXTRACTION_STATUS_TONE).sort()).toEqual([...EXTRACTION_STATUSES].sort());
    expect(Object.keys(COPY_VERSION_STATUS_TONE).sort()).toEqual([...COPY_VERSION_STATUSES].sort());
    expect(Object.keys(COLLECTION_STATUS_TONE).sort()).toEqual([...COLLECTION_STATUSES].sort());
  });

  it("四种语义颜色都在 globals.css 里以设计变量给出", () => {
    for (const name of ["status-draft", "status-generating", "status-pending-publish", "status-published"]) {
      expect(GLOBALS_CSS).toContain(`--${name}:`);
      expect(GLOBALS_CSS).toContain(`--color-${name}:`);
    }
  });

  it("状态色不借用品牌强调色：四种语义各自独立取值", () => {
    // 品牌强调色（--accent / --accent-strong）只用于强调与选中，不允许被状态语义借用，
    // 否则「生成中」和「品牌红」会混在一起，状态就失去了固定含义。
    const statusLines = GLOBALS_CSS.split("\n").filter((line) => line.trim().startsWith("--status-"));
    expect(statusLines.length).toBeGreaterThanOrEqual(8);
    for (const line of statusLines) {
      expect(line).not.toMatch(/(--accent|#ef4d63|#c11f3a)/i);
    }
  });
});
