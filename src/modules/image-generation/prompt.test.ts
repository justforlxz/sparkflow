import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { buildImagePrompt } from "./prompt";
import {
  DEFAULT_IMAGE_SIZE,
  EXTRACT_REQUIREMENTS,
  extractRequirementLabel,
  findExtractRequirement,
} from "./styles";

/**
 * 提示词拼装与提取要求登记表（docs/prd/05「提取目标与提取要求」、ADR 0009）。
 * 这两处都是纯函数，用单测把「哪些内容会进提示词」固定下来。
 */

const AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片提取 Agent",
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://magpie.example.com",
  modelId: null,
  role: "你是素材提取师",
  systemPrompt: "只做提取，不做重绘",
  outputRequirements: "每张原图各输出一张提取图",
};

describe("提取要求登记表（AC-EX-3）", () => {
  it("只剩三项，key 与 PRD 描述一致", () => {
    expect(EXTRACT_REQUIREMENTS.map((entry) => entry.value)).toEqual([
      "faithful",
      "flatten",
      "dereflect",
    ]);
    expect(EXTRACT_REQUIREMENTS.map((entry) => entry.label)).toEqual([
      "忠实还原",
      "平整化",
      "去反光",
    ]);
  });

  it("旧的三项已经被删除", () => {
    for (const legacy of ["fresh", "editorial", "product"]) {
      expect(findExtractRequirement(legacy)).toBeUndefined();
    }
  });

  it("默认尺寸是竖版 1024x1536", () => {
    expect(DEFAULT_IMAGE_SIZE).toBe("1024x1536");
    for (const entry of EXTRACT_REQUIREMENTS) {
      expect(entry.size).toBe(DEFAULT_IMAGE_SIZE);
    }
  });

  it("认不出的 key 原样返回，不因陌生 key 抛错", () => {
    expect(findExtractRequirement("unknown")).toBeUndefined();
    expect(extractRequirementLabel("unknown")).toBe("unknown");
  });
});

describe("提示词拼装", () => {
  it("依次拼上角色、系统提示词、提取目标、提取要求、输出要求与补充要求", () => {
    const prompt = buildImagePrompt({
      agents: AGENT,
      extractTarget: "桌垫的织物纹理",
      extractRequirement: "faithful",
      extraPrompt: "画面里不要出现文字",
    });

    expect(prompt).toContain(AGENT.role);
    expect(prompt).toContain(AGENT.systemPrompt);
    expect(prompt).toContain("提取目标：桌垫的织物纹理");
    expect(prompt).toContain("提取要求：忠实还原——");
    expect(prompt).toContain(findExtractRequirement("faithful")!.description);
    expect(prompt).toContain(`输出要求：${AGENT.outputRequirements}`);
    expect(prompt).toContain("补充要求：画面里不要出现文字");

    // 段落之间有且只有一个空行，避免拼出奇怪的提示词。
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  it("没有补充要求时不留下空标题", () => {
    const prompt = buildImagePrompt({
      agents: AGENT,
      extractTarget: "桌垫的织物纹理",
      extractRequirement: "flatten",
      extraPrompt: null,
    });

    expect(prompt).not.toContain("补充要求");
    expect(prompt.trim()).toBe(prompt);
  });

  it("陌生提取要求用 key 本身填充，不丢这一段", () => {
    const prompt = buildImagePrompt({
      agents: AGENT,
      extractTarget: "桌垫的织物纹理",
      extractRequirement: "sunset",
      extraPrompt: null,
    });

    expect(prompt).toContain("提取要求：sunset");
  });

  it("Agent 里空白的字段整段跳过", () => {
    const prompt = buildImagePrompt({
      agents: { ...AGENT, role: "  ", systemPrompt: "", outputRequirements: "" },
      extractTarget: "桌垫的织物纹理",
      extractRequirement: "dereflect",
      extraPrompt: null,
    });

    expect(prompt.startsWith("提取目标：桌垫的织物纹理")).toBe(true);
    expect(prompt).toContain("提取要求：去反光——");
    expect(prompt).not.toContain("输出要求：");
    expect(prompt).not.toMatch(/^\s/);
  });
});
