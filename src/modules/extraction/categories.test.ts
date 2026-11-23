import { describe, expect, it } from "vitest";
import {
  EXTRACTION_CATEGORIES,
  SELECTABLE_CATEGORIES,
  categoryLabel,
  findCategory,
  isSelectableCategory,
} from "./categories";

/** 类别登记表（ADR 0011 第 1 条、docs/prd/05「内置类别」、AC-LIB-14）。 */
describe("提取类别登记表", () => {
  it("内置三类可选类别，历史类别不可选（AC-LIB-14）", () => {
    expect(SELECTABLE_CATEGORIES.map((entry) => entry.value)).toEqual([
      "topdown",
      "texture",
      "graphic",
    ]);
    expect(isSelectableCategory("topdown")).toBe(true);
    expect(isSelectableCategory("texture")).toBe(true);
    expect(isSelectableCategory("graphic")).toBe(true);
    expect(isSelectableCategory("other")).toBe(false);
    expect(isSelectableCategory("unknown")).toBe(false);
  });

  it("旧的 material / border 已删除，传进来一律被拒绝（AC-LIB-14）", () => {
    expect(findCategory("material")).toBeUndefined();
    expect(findCategory("border")).toBeUndefined();
    expect(isSelectableCategory("material")).toBe(false);
    expect(isSelectableCategory("border")).toBe(false);
  });

  it("每个类别都有中文名与给模型看的目标描述", () => {
    for (const entry of EXTRACTION_CATEGORIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.presenceQuestion.length).toBeGreaterThan(0);
    }
  });

  it("判定问法与提取描述是两句话，不共用（MUST 2b-1、AC-LIB-16）", () => {
    for (const entry of EXTRACTION_CATEGORIES) {
      expect(entry.presenceQuestion).not.toBe(entry.description);
      expect(entry.presenceQuestion).not.toContain(entry.description);
    }
    // 三类可选类别的问法必须各不相同，否则判定会串味。
    const questions = SELECTABLE_CATEGORIES.map((entry) => entry.presenceQuestion);
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("判定问法只问原图里有没有主体，不出现产物形态措辞", () => {
    const productFormWording = ["边缘可平铺", "背景干净", "不要透视畸变", "正面俯视", "摆正", "均匀"];
    for (const entry of SELECTABLE_CATEGORIES) {
      for (const wording of productFormWording) {
        expect(entry.presenceQuestion, `${entry.value} 的问法不应包含「${wording}」`).not.toContain(
          wording,
        );
      }
    }
  });

  it("描述逐字取自 PRD 05 的表格，不在别处再写一版", () => {
    expect(findCategory("topdown")?.description).toBe(
      "从正上方看桌面/桌垫的完整画面；去掉桌面上的摆件与杂物，被遮挡处按周围材质补全；保持原画面长宽比；不要透视畸变",
    );
    expect(findCategory("texture")?.description).toBe(
      "只取桌垫上重复出现的那一块纹理单元；画面内纹理均匀、边缘可平铺；不要出现桌垫边缘与场景",
    );
    expect(findCategory("graphic")?.description).toBe(
      "只取印刷在桌垫上的图案（卡通人物、插画、物品）；正面俯视、无角度、背景干净",
    );
  });

  it("认不出的 key 原样返回，不让历史数据把视图打崩", () => {
    expect(categoryLabel("topdown")).toBe("桌面俯视图");
    expect(categoryLabel("other")).toBe("其他（历史）");
    expect(categoryLabel("legacy-key")).toBe("legacy-key");
    expect(findCategory("legacy-key")).toBeUndefined();
  });
});
