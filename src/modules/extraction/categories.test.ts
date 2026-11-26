import { describe, expect, it } from "vitest";
import {
  EXTRACTION_CATEGORIES,
  MAX_CATEGORY_DESCRIPTION_LENGTH,
  PROMPT_ONLY_TERMS,
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

  it("每个类别都有中文名、界面说明与给模型看的目标描述", () => {
    for (const entry of EXTRACTION_CATEGORIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.promptDescription.length).toBeGreaterThan(0);
      expect(entry.presenceQuestion.length).toBeGreaterThan(0);
    }
  });

  it("判定问法与两份描述是不同的话，不共用（MUST 2b-1、AC-LIB-16）", () => {
    for (const entry of EXTRACTION_CATEGORIES) {
      for (const description of [entry.description, entry.promptDescription]) {
        expect(entry.presenceQuestion).not.toBe(description);
        expect(entry.presenceQuestion).not.toContain(description);
      }
    }
    // 三类可选类别的界面说明与提示词描述必须是两份文本，不能图省事复用一份（AC-PROMPT-6）；
    // 历史类别（other）不进界面也不进提示词，两句同文不影响。
    for (const entry of SELECTABLE_CATEGORIES) {
      expect(entry.description).not.toBe(entry.promptDescription);
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

  it("界面说明与提取目标描述逐字取自 PRD 05 的表格，不在别处再写一版", () => {
    // PRD 05 的类别表有两列：界面说明（给用户）与提取目标描述（给生图模型）。
    expect(findCategory("topdown")?.description).toBe(
      "从正上方看桌面或桌垫的完整画面，去掉摆件与杂物，被遮挡处按周围材质补全",
    );
    expect(findCategory("texture")?.description).toBe(
      "只取重复出现的那一块纹理单元，纹理均匀、四边可拼接，不出现桌垫边缘与场景",
    );
    expect(findCategory("graphic")?.description).toBe(
      "只取印刷在桌垫上的图案（卡通人物、插画、物品），文字照原样、背景干净",
    );

    expect(findCategory("topdown")?.promptDescription).toBe(
      "完美平整的俯视图（perfectly flat orthographic view，zero perspective，zero foreshortening）；所有长边与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光、无景深；去掉桌面上的摆件与杂物，被遮挡处按周围材质补全；保持桌面自身的长宽比，不拉伸、不裁切",
    );
    expect(findCategory("texture")?.promptDescription).toBe(
      "只取重复出现的那一块纹理单元，四边可无缝拼接（matching opposite edges）；这是材质不是场景（This is a material texture, not a scene）；perfectly flat orthographic view，zero perspective，zero foreshortening；所有线与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光；不要出现桌垫边缘与场景；保持纹理自身的长宽比，不拉伸、不裁切",
    );
    expect(findCategory("graphic")?.promptDescription).toBe(
      "把这张照片里桌垫上印制的图案原样抠出来，铺在纯色背景上。严格保持图案里的一切不变：角色与动物的造型、表情、动作、线条、配色，以及全部文字的字形与拼写，必须与照片里完全一致。不要重新绘制、不要风格化、不要补全、不要添加照片里没有的任何元素（包括标题、边框、装饰、散落的点缀）。保留图案原本的倾斜与透视，不要旋转或摆正。不拉伸、不裁切",
    );
  });

  it("三类提取目标描述各不相同，且都不含「铺满画面」（AC-PROMPT-2）", () => {
    const descriptions = SELECTABLE_CATEGORIES.map((entry) => entry.promptDescription);
    // 三类产物形态不同，描述不能复用同一句。
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const description of descriptions) {
      expect(description).not.toContain("铺满画面");
    }
  });

  it("形象设计的提取目标描述改成保真约束，不再要求摆正透视（AC-FID-1、AC-FID-2、AC-FID-3）", () => {
    const graphic = findCategory("graphic")?.promptDescription ?? "";
    // 保真：原样抠出、文字逐字一致、不加原图没有的元素、不摆正透视。
    expect(graphic).toContain("原样抠出来");
    expect(graphic).toContain("全部文字的字形与拼写");
    expect(graphic).toContain("不要重新绘制");
    expect(graphic).toContain("不要添加照片里没有的任何元素");
    expect(graphic).toContain("不要旋转或摆正");
    expect(graphic).toContain("不拉伸、不裁切");
    // 逼模型整幅重画的那几句一条都不许回来（MKACG-1016 的根因）。
    for (const term of PROMPT_ONLY_TERMS) {
      expect(graphic, `形象设计的提示词又出现了「${term}」`).not.toContain(term);
    }
    expect(graphic).not.toContain("正面平视");
    expect(graphic).not.toContain("front-on");
    expect(graphic).not.toContain("不倾斜");
    // 界面说明同样不许再承诺「正面平视」：模型做不到，写了就是假承诺（AC-FID-3）。
    const description = findCategory("graphic")?.description ?? "";
    expect(description).not.toContain("平视");
    expect(description).not.toContain("俯视");
  });

  it("AC-PROMPT-6 界面说明是简短中文，不含任何提示词工程术语", () => {
    for (const entry of SELECTABLE_CATEGORIES) {
      const description = entry.description;
      for (const term of PROMPT_ONLY_TERMS) {
        expect(description, `${entry.value} 的界面说明出现了提示词术语「${term}」`).not.toContain(term);
      }
      // 界面说明用中文写：夹英文是提示词工程文本漏到界面的信号。
      expect(description, `${entry.value} 的界面说明不应含英文字母`).not.toMatch(/[A-Za-z]/);
      expect(description.length).toBeLessThanOrEqual(MAX_CATEGORY_DESCRIPTION_LENGTH);
    }
  });

  it("认不出的 key 原样返回，不让历史数据把视图打崩", () => {
    expect(categoryLabel("topdown")).toBe("桌面俯视图");
    expect(categoryLabel("other")).toBe("其他（历史）");
    expect(categoryLabel("legacy-key")).toBe("legacy-key");
    expect(findCategory("legacy-key")).toBeUndefined();
  });
});
