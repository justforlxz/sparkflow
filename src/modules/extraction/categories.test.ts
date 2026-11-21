import { describe, expect, it } from "vitest";
import {
  EXTRACTION_CATEGORIES,
  SELECTABLE_CATEGORIES,
  categoryLabel,
  findCategory,
  isSelectableCategory,
} from "./categories";

/** 类别登记表（ADR 0010 第 2 条、docs/prd/12 MUST 2、MUST 3）。 */
describe("提取类别登记表", () => {
  it("内置两类可选类别，历史类别不可选", () => {
    expect(SELECTABLE_CATEGORIES.map((entry) => entry.value)).toEqual(["material", "border"]);
    expect(isSelectableCategory("material")).toBe(true);
    expect(isSelectableCategory("border")).toBe(true);
    expect(isSelectableCategory("other")).toBe(false);
    expect(isSelectableCategory("unknown")).toBe(false);
  });

  it("每个类别都有中文名与给模型看的目标描述", () => {
    for (const entry of EXTRACTION_CATEGORIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("认不出的 key 原样返回，不让历史数据把视图打崩", () => {
    expect(categoryLabel("material")).toBe("材质纹理");
    expect(categoryLabel("other")).toBe("其他（历史）");
    expect(categoryLabel("legacy-key")).toBe("legacy-key");
    expect(findCategory("legacy-key")).toBeUndefined();
  });
});
