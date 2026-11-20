import { describe, expect, it } from "vitest";
import { buildCopyPrompt, type CopyPromptInput } from "./prompt";
import { EXTRACT_REQUIREMENTS, findExtractRequirement } from "@/modules/image-generation/styles";

const INPUT: CopyPromptInput = {
  agent: {
    role: "你是一名小红书文案撰写者。",
    systemPrompt: "只依据原始素材与图片描述写作。",
    outputRequirements: "输出 JSON：title、body、tags。",
  },
  collection: {
    platform: "小红书",
    sourceTitle: "原始标题在这里",
    sourceBody: "原始文案在这里",
    extractTarget: "桌垫的织物纹理",
  },
  images: {
    extractedCount: 4,
    descriptions: ["米白色棉麻织纹，细密的十字纹路", "浅灰亚麻纹理，织线略粗"],
    extractRequirement: "faithful",
  },
  copyStyle: "story",
  extraPrompt: "语气再轻松一点",
};

describe("提示词拼装（docs/prd/06「输入拼装」）", () => {
  it("AC-06-7 每张原图的视觉描述按编号都进提示词，且与编号对齐", () => {
    const { user } = buildCopyPrompt(INPUT);

    for (const [index, description] of INPUT.images.descriptions.entries()) {
      expect(user).toContain(`  ${index + 1}. ${description}`);
    }
    expect(user).toContain("按原图编号");
  });

  it("没有视觉描述时明说未提供，不假装看过图（AC-06-8 的降级路径）", () => {
    const { user } = buildCopyPrompt({
      ...INPUT,
      images: { ...INPUT.images, descriptions: [] },
    });

    expect(user).toContain("目标的材质/纹理/图案：未提供");
    expect(user).toContain("本次没有获取到照片内容");
  });
});

describe("提示词拼装（docs/prd/06「输入拼装」）", () => {
  it("第一部分：Agent 快照的 role、systemPrompt、outputRequirements 都进 system", () => {
    const { system } = buildCopyPrompt(INPUT);

    expect(system).toContain(INPUT.agent.role);
    expect(system).toContain(INPUT.agent.systemPrompt);
    expect(system).toContain(INPUT.agent.outputRequirements);
  });

  it("第二部分：来源信息与提取目标进 user，并明确原始文案只作参考", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("平台：小红书");
    expect(user).toContain("原始标题：原始标题在这里");
    expect(user).toContain("原始文案在这里");
    expect(user).toContain("不得照搬");
    expect(user).toContain("不得当作待改写文本");
    expect(user).toContain("提取目标：桌垫的织物纹理");
  });

  it("AC-EX-5 文案提示词含提取目标与「目标的材质/纹理/图案」要求", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("提取目标：桌垫的织物纹理");
    expect(user).toContain("目标的材质/纹理/图案");
    expect(user).toContain("只写目标的材质、纹理、图案与颜色");
    expect(user).toContain("不写照片里的场景与道具");
  });

  it("第三部分：素材图给出张数与提取要求描述，不含图片字节", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("张数：4");
    expect(user).toContain("提取要求：");
    expect(user).toContain(findExtractRequirement("faithful")!.description);
    expect(user).not.toContain("data:image");
  });

  it("AC-FIX-2 三个提取要求各自取到自己的描述，不串用", () => {
    for (const requirement of EXTRACT_REQUIREMENTS) {
      const { user } = buildCopyPrompt({
        ...INPUT,
        images: { ...INPUT.images, extractRequirement: requirement.value },
      });

      expect(user, requirement.value).toContain(requirement.description);

      for (const other of EXTRACT_REQUIREMENTS.filter(
        (entry) => entry.value !== requirement.value,
      )) {
        expect(user, `${requirement.value} 不应包含 ${other.value} 的描述`).not.toContain(
          other.description,
        );
      }
    }
  });

  it("AC-FIX-3 未知的提取要求 key 按原文呈现，不抛错、不编造描述", () => {
    const { user } = buildCopyPrompt({
      ...INPUT,
      images: { ...INPUT.images, extractRequirement: "sunset" },
    });

    expect(user).toContain("提取要求：sunset");
    for (const requirement of EXTRACT_REQUIREMENTS) {
      expect(user).not.toContain(requirement.description);
    }
  });

  it("第四部分：文案风格换成描述，补充要求原样带上", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("文案风格：故事分享");
    expect(user).toContain("补充要求：语气再轻松一点");
  });

  it("没有补充要求时写「无」；没有来源信息与提取目标时写「未填写」", () => {
    const { user } = buildCopyPrompt({
      ...INPUT,
      collection: { platform: null, sourceTitle: null, sourceBody: null, extractTarget: null },
      extraPrompt: null,
    });

    expect(user).toContain("平台：未填写");
    expect(user).toContain("原始标题：未填写");
    expect(user).toContain("提取目标：未填写");
    expect(user).toContain("补充要求：无");
  });

  it("未知的文案风格 key 原样交给模型，不编造描述", () => {
    const { user } = buildCopyPrompt({ ...INPUT, copyStyle: "custom-style" });
    expect(user).toContain("custom-style");
  });

  it("内容约束与输出结构固定在 system 里（不照搬、不编造参数与体验）", () => {
    const { system } = buildCopyPrompt(INPUT);

    expect(system).toContain("不得照搬原始文案");
    expect(system).toContain("不得编造商品参数、功效、价格");
    expect(system).toContain("个人使用体验");
    expect(system).toContain("只输出一个 JSON 对象");
    expect(system).toContain('"title"');
  });
});
