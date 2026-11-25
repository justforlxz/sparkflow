import { describe, expect, it } from "vitest";
import { findCategory } from "@/modules/extraction/categories";
import {
  MAX_MATERIAL_DESCRIPTION_LENGTH,
  MATERIAL_PROMPT_MARK,
  buildMaterialPrompt,
  parseMaterialDescription,
} from "./material";

/** 材质描述（MKACG-1000、AC-PROMPT-3）：两段式提示词的第一段。 */
describe("材质描述的提问", () => {
  it("带固定标记，并点出该类别的中文名", () => {
    const text = buildMaterialPrompt("graphic");

    expect(text.startsWith(MATERIAL_PROMPT_MARK)).toBe(true);
    expect(text).toContain(findCategory("graphic")?.label ?? "");
  });

  it("只描述材质与图案，不让模型评价或推测用途", () => {
    const text = buildMaterialPrompt("texture");

    expect(text).toContain("只描述看到的材质与图案");
    expect(text).not.toContain("评价好坏的具体结论");
  });

  it("认不出的类别 key 原样放进句子，不让提示词变形", () => {
    expect(buildMaterialPrompt("legacy-key")).toContain("「legacy-key」");
  });
});

describe("材质描述的解析", () => {
  it("空白归一化后原样返回", () => {
    expect(parseMaterialDescription("  深灰色织物，\n表面有细密斜纹  ")).toBe(
      "深灰色织物， 表面有细密斜纹",
    );
  });

  it("回复为空（模型什么都没说）时返回 null，调用方据此跳过该段", () => {
    expect(parseMaterialDescription("")).toBeNull();
    expect(parseMaterialDescription("  \n\t ")).toBeNull();
  });

  it("超长截断并补省略号，不把整段长篇塞进生图提示词", () => {
    const description = parseMaterialDescription("纹".repeat(MAX_MATERIAL_DESCRIPTION_LENGTH + 50));

    expect(description).toHaveLength(MAX_MATERIAL_DESCRIPTION_LENGTH + 1);
    expect(description?.endsWith("…")).toBe(true);
  });

  it("刚好到上限时不截断", () => {
    const text = "纹".repeat(MAX_MATERIAL_DESCRIPTION_LENGTH);

    expect(parseMaterialDescription(text)).toBe(text);
  });
});
