/**
 * 提示词拼装（docs/prd/06-copy-generation.md「输入拼装」）。
 *
 * 四部分各自独立、显式列出，改其中一部分不影响流程：
 * 1. Agent 快照的 role / systemPrompt / outputRequirements；
 * 2. 资源夹来源信息（原始文案只作参考意见，不是待改写文本）；
 * 3. 本次生成图片的描述（张数 + 视觉方向；不传图片二进制）；
 * 4. 任务参数（文案风格、补充要求）。
 *
 * 返回 `{ system, user }` 两条消息：内容约束与输出结构放 system，素材与本次要求放 user。
 * 模板变量集中在 `CopyPromptInput`，单测直接断言每一部分。
 */
import { findVisualStyle } from "@/modules/image-generation/styles";
import { describeCopyStyle } from "./styles";

export interface CopyPromptInput {
  agent: {
    role: string;
    systemPrompt: string;
    outputRequirements: string;
  };
  collection: {
    platform: string | null;
    sourceTitle: string | null;
    sourceBody: string | null;
  };
  images: {
    /** 本次生成的成品图张数（= 原图张数，ADR 0008）。 */
    generatedCount: number;
    /** 每张原图一条视觉描述，按原图顺序编号；空数组表示这次没有提取到内容。 */
    descriptions: readonly string[];
    /** 视觉方向的 key（由图片创作模块登记）；描述也从那份登记表取，这里不另写一份。 */
    visualStyle: string;
  };
  copyStyle: string;
  extraPrompt: string | null;
}

export interface CopyPrompt {
  system: string;
  user: string;
}

/** 输出结构要求固定在提示词里：解析器只认这个形状（docs/prd/06「输出结构」MUST）。 */
const OUTPUT_STRUCTURE = [
  "输出结构（必须遵守）：",
  "只输出一个 JSON 对象，不要输出解释、前言或 Markdown 正文：",
  '{"title": "不超过 20 字的标题", "body": "正文，段落之间空一行", "tags": ["标签1", "标签2"]}',
  "tags 最多 10 个，不带 # 号；不要输出 JSON 之外的任何文字。",
].join("\n");

/** 内容约束（docs/prd/06「内容约束」MUST NOT）。 */
const CONTENT_RULES = [
  "内容约束（必须遵守）：",
  "- 不得照搬原始文案：必须用自己的话重写，允许参考它的信息点。",
  "- 不得编造商品参数、功效、价格、优惠或个人使用体验；素材里没有的事实不写。",
  "- 不得描述画面里看不见的细节；图片描述只用给定信息。",
].join("\n");

function orPlaceholder(value: string | null, placeholder: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : placeholder;
}

/**
 * 视觉方向进提示词的样子：名称加描述，描述取自图片模块的登记表（docs/architecture.md 第 5 节）。
 * 认不出的 key 按原文交给模型，不编造描述 —— 与文案风格的既有做法一致。
 */
function describeVisualStyle(value: string): string {
  const style = findVisualStyle(value);
  return style ? `${style.label}——${style.description}` : value;
}

export function buildCopyPrompt(input: CopyPromptInput): CopyPrompt {
  const { agent, collection, images, copyStyle, extraPrompt } = input;

  const system = [
    agent.role.trim(),
    agent.systemPrompt.trim(),
    OUTPUT_STRUCTURE,
    agent.outputRequirements.trim(),
    CONTENT_RULES,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  const user = [
    "【来源信息】",
    `- 平台：${orPlaceholder(collection.platform, "未填写")}`,
    `- 原始标题：${orPlaceholder(collection.sourceTitle, "未填写")}`,
    `- 原始文案（仅作参考，不得照搬，也不得当作待改写文本）：${orPlaceholder(collection.sourceBody, "未填写")}`,
    "",
    "【本次生成的图片】",
    `- 张数：${images.generatedCount}`,
    `- 视觉方向：${describeVisualStyle(images.visualStyle)}`,
    ...describeVisualDescriptions(images.descriptions),
    "- 说明：这批图片按上述视觉方向生成，文案语气与画面调性保持一致。",
    "",
    "【这次的要求】",
    `- 文案风格：${describeCopyStyle(copyStyle)}`,
    `- 补充要求：${orPlaceholder(extraPrompt, "无")}`,
  ].join("\n");

  return { system, user };
}

/**
 * 视觉描述进提示词的样子（docs/prd/06「视觉提取」）：按原图编号逐条列出，
 * 第 k 条对应第 k 张原图与第 k 张成品图。没有描述时明说「未提供」，不假装看过图。
 */
function describeVisualDescriptions(descriptions: readonly string[]): string[] {
  if (descriptions.length === 0) {
    return ["- 照片内容：未提供（本次没有获取到照片内容）"];
  }

  return [
    "- 照片内容（按原图编号，第 k 条对应第 k 张原图与成品图）：",
    ...descriptions.map((description, index) => `  ${index + 1}. ${description}`),
  ];
}
