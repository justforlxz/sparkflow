import { describe, expect, it } from "vitest";
import { buildCopyPrompt } from "./prompt";
import type { SelectedAssetRef } from "./types";

const AGENT = {
  role: "你是一名小红书图文创作者",
  systemPrompt: "只写素材里能看出的事实",
  outputRequirements: "标题不超过 20 字",
};

const SELECTED: SelectedAssetRef[] = [
  { id: "asset-1", category: "material", fileName: "a.png", mimeType: "image/png" },
  { id: "asset-2", category: "material", fileName: "b.png", mimeType: "image/png" },
  { id: "asset-3", category: "border", fileName: "c.png", mimeType: "image/png" },
];

/** 提示词拼装（docs/prd/06「输入拼装」）：四部分各自独立可断言。 */
describe("文案提示词", () => {
  it("system 里有 Agent 的三段配置、输出结构与内容约束", () => {
    const { system } = buildCopyPrompt({
      agent: AGENT,
      collection: { platform: "小红书", sourceTitle: "原始标题", sourceBody: "原始文案" },
      assets: { selected: SELECTED, descriptions: ["有布纹", "布纹清楚", "细边框"] },
      copyStyle: "story",
      extraPrompt: null,
    });

    expect(system).toContain(AGENT.role);
    expect(system).toContain(AGENT.systemPrompt);
    expect(system).toContain(AGENT.outputRequirements);
    expect(system).toContain('"title"');
    expect(system).toContain("不得照搬原始文案");
  });

  it("user 里有来源信息、选中素材的张数与类别分布（ADR 0010 的输入来源）", () => {
    const { user } = buildCopyPrompt({
      agent: AGENT,
      collection: { platform: "小红书", sourceTitle: "原始标题", sourceBody: "原始文案" },
      assets: { selected: SELECTED, descriptions: ["有布纹", "布纹清楚", "细边框"] },
      copyStyle: "story",
      extraPrompt: "强调耐用",
    });

    expect(user).toContain("平台：小红书");
    expect(user).toContain("原始标题：原始标题");
    expect(user).toContain("张数：3");
    expect(user).toContain("材质纹理 2 张、边框样式 1 张");
    // 每张素材一条描述，按素材顺序编号。
    expect(user).toContain("1. [材质纹理] 有布纹");
    expect(user).toContain("3. [边框样式] 细边框");
    expect(user).toContain("文案风格：故事分享");
    expect(user).toContain("补充要求：强调耐用");
  });

  it("没有视觉描述时明说「未提供」，不假装看过图", () => {
    const { user } = buildCopyPrompt({
      agent: AGENT,
      collection: { platform: null, sourceTitle: null, sourceBody: null },
      assets: { selected: SELECTED, descriptions: [] },
      copyStyle: "note",
      extraPrompt: null,
    });

    expect(user).toContain("未提供（本次没有获取到素材内容）");
    expect(user).toContain("平台：未填写");
  });

  it("只写素材特征，不提场景与道具", () => {
    const { user } = buildCopyPrompt({
      agent: AGENT,
      collection: { platform: null, sourceTitle: null, sourceBody: null },
      assets: { selected: SELECTED, descriptions: ["有布纹", "布纹清楚", "细边框"] },
      copyStyle: "warm",
      extraPrompt: null,
    });

    expect(user).toContain("不写照片里的场景与道具");
  });
});
