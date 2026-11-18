import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGE_STATUSES, TASK_STATUSES } from "@/modules/generation/constants";
import { COLLECTION_STATUSES } from "@/modules/media-collection/constants";
import {
  COLLECTION_STATUS_TONE,
  STAGE_STATUS_TONE,
  TASK_STATUS_TONE,
} from "./status-tone";

/**
 * 状态标签颜色语义（docs/prd/09 SHOULD、AC-10-9）：
 * 待创作=蓝、生成中=强调色、待发布=橙、已发布=绿，颜色只来自 `globals.css` 的设计变量。
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

  it("任务与阶段状态都有色板，不漏项", () => {
    expect(Object.keys(TASK_STATUS_TONE).sort()).toEqual([...TASK_STATUSES].sort());
    expect(Object.keys(STAGE_STATUS_TONE).sort()).toEqual([...STAGE_STATUSES].sort());
    expect(Object.keys(COLLECTION_STATUS_TONE).sort()).toEqual([...COLLECTION_STATUSES].sort());
  });

  it("四种语义颜色都在 globals.css 里以设计变量给出", () => {
    for (const name of ["status-draft", "status-generating", "status-pending-publish", "status-published"]) {
      expect(GLOBALS_CSS).toContain(`--${name}:`);
      expect(GLOBALS_CSS).toContain(`--color-${name}:`);
    }
  });

  it("globals.css 之外的状态色不出现颜色字面值", () => {
    expect(GLOBALS_CSS).not.toMatch(/#ef4d63/i);
  });
});
