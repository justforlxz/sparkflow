import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { buildImagePrompt } from "./prompt";
import { DEFAULT_IMAGE_SIZE, VISUAL_STYLES, findVisualStyle, visualStyleLabel } from "./styles";

/**
 * 提示词拼装与视觉方向登记表（docs/prd/05 MUST 6、SHOULD「视觉方向」）。
 * 这两处都是纯函数，用单测把「哪些内容会进提示词」固定下来。
 */

const AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片创作 Agent",
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://magpie.example.com",
  modelId: null,
  role: "你是生活方式图片创作者",
  systemPrompt: "画面干净，主体明确",
  outputRequirements: "竖版，适合手机浏览",
};

describe("视觉方向登记表", () => {
  it("登记三个方向，key 与 PRD 描述一致", () => {
    expect(VISUAL_STYLES.map((style) => style.value)).toEqual(["fresh", "editorial", "product"]);
    expect(VISUAL_STYLES.map((style) => style.label)).toEqual(["清新生活感", "杂志视觉", "产品质感"]);
  });

  it("默认尺寸是竖版 1024x1536，产品质感可覆盖", () => {
    expect(DEFAULT_IMAGE_SIZE).toBe("1024x1536");
    expect(findVisualStyle("fresh")?.size).toBe(DEFAULT_IMAGE_SIZE);
    expect(findVisualStyle("product")?.size).toBe("1024x1024");
  });

  it("认不出的方向 key 原样返回，不因陌生 key 抛错", () => {
    expect(findVisualStyle("unknown")).toBeUndefined();
    expect(visualStyleLabel("unknown")).toBe("unknown");
  });
});

describe("提示词拼装", () => {
  it("依次拼上角色、系统提示词、视觉方向、输出要求与补充要求", () => {
    const prompt = buildImagePrompt({
      agents: AGENT,
      visualStyle: "fresh",
      extraPrompt: "画面里不要出现文字",
    });

    expect(prompt).toContain(AGENT.role);
    expect(prompt).toContain(AGENT.systemPrompt);
    expect(prompt).toContain("视觉方向：清新生活感——");
    expect(prompt).toContain(findVisualStyle("fresh")!.description);
    expect(prompt).toContain(`输出要求：${AGENT.outputRequirements}`);
    expect(prompt).toContain("补充要求：画面里不要出现文字");

    // 段落之间有且只有一个空行，避免拼出奇怪的提示词。
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  it("没有补充要求时不留下空标题", () => {
    const prompt = buildImagePrompt({ agents: AGENT, visualStyle: "editorial", extraPrompt: null });

    expect(prompt).not.toContain("补充要求");
    expect(prompt.trim()).toBe(prompt);
  });

  it("陌生视觉方向用 key 本身填充，不丢这一段", () => {
    const prompt = buildImagePrompt({ agents: AGENT, visualStyle: "sunset", extraPrompt: null });

    expect(prompt).toContain("视觉方向：sunset");
  });

  it("Agent 里空白的字段整段跳过", () => {
    const prompt = buildImagePrompt({
      agents: { ...AGENT, role: "  ", systemPrompt: "", outputRequirements: "" },
      visualStyle: "product",
      extraPrompt: null,
    });

    expect(prompt.startsWith("视觉方向：产品质感")).toBe(true);
    expect(prompt).not.toContain("输出要求：");
    expect(prompt).not.toMatch(/^\s/);
  });
});
