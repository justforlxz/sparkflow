/**
 * 提示词拼装（docs/prd/06-copy-generation.md「输入拼装」，ADR 0010）。
 *
 * 四部分各自独立、显式列出，改其中一部分不影响流程：
 * 1. Agent 快照的 role / systemPrompt / outputRequirements；
 * 2. 资源夹来源信息（原始文案只作参考意见，不是待改写文本）；
 * 3. 本次选中的素材（类别分布 + 每张图的目标特征描述；不传图片二进制）；
 * 4. 这次的要求（文案风格、补充要求）。
 *
 * 返回 `{ system, user }` 两条消息：内容约束与输出结构放 system，素材与本次要求放 user。
 * 模板变量集中在 `CopyPromptInput`，单测直接断言每一部分。
 */
import { categoryLabel } from "@/modules/extraction/categories";
import type { SelectedAssetRef } from "./types";
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
  assets: {
    /** 选中的素材清单（顺序即版本里记录的顺序）。 */
    selected: readonly SelectedAssetRef[];
    /** 每张素材一条目标特征描述，与 `selected` 同序；空数组表示这次没有获取到内容。 */
    descriptions: readonly string[];
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

/** 类别分布：「桌面俯视图 2 张、基本纹理 1 张」。 */
function describeCategories(selected: readonly SelectedAssetRef[]): string {
  const counts = new Map<string, number>();
  for (const asset of selected) {
    counts.set(asset.category, (counts.get(asset.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => `${categoryLabel(category)} ${count} 张`)
    .join("、");
}

/**
 * 目标特征描述进提示词的样子：按素材顺序逐条列出，第 k 条对应第 k 张素材。
 * 没有描述时明说「未提供」，不假装看过图。
 */
function describeVisualDescriptions(
  selected: readonly SelectedAssetRef[],
  descriptions: readonly string[],
): string[] {
  if (descriptions.length === 0) {
    return ["- 素材的材质/纹理/图案：未提供（本次没有获取到素材内容）"];
  }

  return [
    "- 素材的材质/纹理/图案（按素材顺序，第 k 条对应第 k 张素材）：",
    ...descriptions.map(
      (description, index) =>
        `  ${index + 1}. [${categoryLabel(selected[index]?.category ?? "")}] ${description}`,
    ),
  ];
}

export function buildCopyPrompt(input: CopyPromptInput): CopyPrompt {
  const { agent, collection, assets, copyStyle, extraPrompt } = input;
  const count = assets.selected.length;

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
    "【本次选中的素材】",
    `- 张数：${count}`,
    `- 类别：${describeCategories(assets.selected)}`,
    ...describeVisualDescriptions(assets.selected, assets.descriptions),
    `- 说明：文案只围绕这 ${count} 张素材的材质、纹理、图案与颜色来写，不写照片里的场景与道具。`,
    "",
    "【这次的要求】",
    `- 文案风格：${describeCopyStyle(copyStyle)}`,
    `- 补充要求：${orPlaceholder(extraPrompt, "无")}`,
  ].join("\n");

  return { system, user };
}
