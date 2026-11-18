import { describe, expect, it } from "vitest";
import { buildCopyPrompt, type CopyPromptInput } from "./prompt";

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
  },
  images: { count: 4, visualStyle: "fresh" },
  copyStyle: "story",
  extraPrompt: "语气再轻松一点",
};

describe("提示词拼装（docs/prd/06「输入拼装」）", () => {
  it("第一部分：Agent 快照的 role、systemPrompt、outputRequirements 都进 system", () => {
    const { system } = buildCopyPrompt(INPUT);

    expect(system).toContain(INPUT.agent.role);
    expect(system).toContain(INPUT.agent.systemPrompt);
    expect(system).toContain(INPUT.agent.outputRequirements);
  });

  it("第二部分：来源信息进 user，并明确原始文案只作参考", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("平台：小红书");
    expect(user).toContain("原始标题：原始标题在这里");
    expect(user).toContain("原始文案在这里");
    expect(user).toContain("不得照搬");
    expect(user).toContain("不得当作待改写文本");
  });

  it("第三部分：图片描述只有张数与视觉方向，不含图片字节", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("张数：4");
    expect(user).toContain("视觉方向代号：fresh");
    expect(user).not.toContain("data:image");
  });

  it("第四部分：文案风格换成描述，补充要求原样带上", () => {
    const { user } = buildCopyPrompt(INPUT);

    expect(user).toContain("文案风格：故事分享");
    expect(user).toContain("补充要求：语气再轻松一点");
  });

  it("没有补充要求时写「无」；没有来源信息时写「未填写」", () => {
    const { user } = buildCopyPrompt({
      ...INPUT,
      collection: { platform: null, sourceTitle: null, sourceBody: null },
      extraPrompt: null,
    });

    expect(user).toContain("平台：未填写");
    expect(user).toContain("原始标题：未填写");
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
