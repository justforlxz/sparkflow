import { describe, expect, it } from "vitest";
import { AGENT_DEFAULTS } from "@/modules/agent-config/defaults";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { SELECTABLE_CATEGORIES } from "@/modules/extraction/categories";
import { EXTRACT_REQUIREMENTS, findExtractRequirement } from "./styles";
import { buildImagePrompt, describeCategory } from "./prompt";

/** 图片 Agent 的默认快照：提示词里的 role / systemPrompt / outputRequirements 取自默认文案。 */
const AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: AGENT_DEFAULTS.image.name,
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://example.com",
  modelId: "image-model",
  role: AGENT_DEFAULTS.image.role,
  systemPrompt: AGENT_DEFAULTS.image.systemPrompt,
  outputRequirements: AGENT_DEFAULTS.image.outputRequirements,
};

/** 可判定的几何词（MKACG-1000）：同类纹理提取流水线的四份独立来源一致使用这几组。 */
const GEOMETRY_PHRASES = [
  "orthographic",
  "zero perspective",
  "zero foreshortening",
  "exactly horizontal or vertical",
  "no shadows",
] as const;

function prompt(category: string, extractRequirement = "faithful", material: string | null = null) {
  return buildImagePrompt({ agents: AGENT, category, extractRequirement, material, extraPrompt: null });
}

/** 提取提示词拼装（docs/prd/05 SHOULD、MKACG-1000）。 */
describe("提取提示词拼装", () => {
  it("AC-PROMPT-1 桌面俯视图与基本纹理的提示词含五组可判定的几何词，且三类都不含「铺满画面」", () => {
    // 几何约束只属于需要「摆正成俯视/平铺」的两类；形象设计从 MKACG-1016 起改成保真约束，
    // 这几句在它那里是逼模型整幅重画的元凶（见下一条用例）。
    for (const definition of SELECTABLE_CATEGORIES) {
      const text = prompt(definition.value);
      const geometryCategories = ["topdown", "texture"];
      if (geometryCategories.includes(definition.value)) {
        for (const phrase of GEOMETRY_PHRASES) {
          expect(text, `${definition.value} 的提示词缺少「${phrase}」`).toContain(phrase);
        }
      }
      expect(text, `${definition.value} 的提示词仍命令模型铺满画面`).not.toContain("铺满画面");
    }
  });

  it("AC-PROMPT-1 三种提取要求的提示词都不含「铺满画面」", () => {
    // 提取要求也是提示词的一段：`flatten` 曾经写「让纹理均匀铺满画面」，等于命令模型拉伸。
    for (const requirement of EXTRACT_REQUIREMENTS) {
      for (const definition of SELECTABLE_CATEGORIES) {
        const text = prompt(definition.value, requirement.value);
        expect(text, `${definition.value} × ${requirement.value}`).not.toContain("铺满画面");
        expect(text).toContain(findExtractRequirement(requirement.value)?.description ?? "");
      }
    }
  });

  it("AC-PROMPT-2 形象设计的提示词改成保真约束，不再要求摆正透视", () => {
    const text = prompt("graphic");
    expect(text).toContain("形象设计——");
    expect(text).toContain(describeCategory("graphic"));
    // 保真约束：原样抠出、文字逐字一致、不加元素、不摆正、不拉伸。
    expect(text).toContain("原样抠出来");
    expect(text).toContain("全部文字的字形与拼写");
    expect(text).toContain("不要添加照片里没有的任何元素");
    expect(text).toContain("不要旋转或摆正");
    expect(text).toContain("不拉伸、不裁切");
    // 类别那一段里不许再出现逼模型整幅重画的正交措辞（MKACG-1016 的根因）。
    const categorySection = describeCategory("graphic");
    for (const phrase of GEOMETRY_PHRASES) {
      expect(categorySection, `形象设计的类别描述又出现了「${phrase}」`).not.toContain(phrase);
    }
    expect(categorySection).not.toContain("正面平视");
  });

  it("AC-PROMPT-3 有材质描述时拼成 `Material:` 段，并排在提取要求之前", () => {
    const text = prompt("topdown", "faithful", "深灰色织物，表面有细密斜纹");

    expect(text).toContain("Material: 深灰色织物，表面有细密斜纹");
    expect(text.indexOf("Material: ")).toBeLessThan(text.indexOf("提取要求："));
  });

  it("AC-PROMPT-3 没有材质描述时整段跳过，不留空标题", () => {
    for (const material of [null, "", "   "]) {
      const text = prompt("topdown", "faithful", material);
      expect(text).not.toContain("Material:");
    }
  });

  it("空字段整段跳过：补充要求为空时不留「补充要求：」标题", () => {
    const text = buildImagePrompt({
      agents: AGENT,
      category: "topdown",
      extractRequirement: "faithful",
      material: null,
      extraPrompt: "   ",
    });

    expect(text).not.toContain("补充要求：");
    expect(text).toContain("输出要求：");
  });

  it("认不出的类别 key 原样交给模型，不编造描述", () => {
    expect(describeCategory("legacy-key")).toBe("legacy-key");
    expect(prompt("legacy-key")).toContain("提取目标：legacy-key");
  });
});
