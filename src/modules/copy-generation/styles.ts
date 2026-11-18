/**
 * 文案风格登记表（docs/architecture.md 第 5 节：新的文案风格加在对应模块的 `styles.ts`）。
 *
 * 任务参数 `copy_style` 存的是这里的 `value`（短 key），页面只引用 key（AGENTS.md 硬性规则 1）；
 * 提示词里换成 `prompt` 里的描述。未知 key 不做拦截 —— 任务可能是在这版之前创建的 ——
 * 直接按 key 原文交给模型，不编造描述。
 */

export interface CopyStyle {
  value: string;
  label: string;
  /** 拼进提示词的一句话描述。 */
  prompt: string;
}

export const COPY_STYLES: readonly CopyStyle[] = [
  {
    value: "story",
    label: "故事分享",
    prompt: "第一人称讲故事，有具体场景与感受，段落短，结尾落到一句总结或提问。",
  },
  {
    value: "note",
    label: "实用笔记",
    prompt: "先给结论再分点说明，信息密度高，条目清楚，读者可以直接照着做。",
  },
  {
    value: "warm",
    label: "温柔日常",
    prompt: "像跟朋友聊天一样口语化，语气松弛，少用感叹号，不堆形容词。",
  },
];

export function findCopyStyle(value: string): CopyStyle | undefined {
  return COPY_STYLES.find((style) => style.value === value);
}

/** 提示词里的文案风格描述；未知 key 回退成 key 原文。 */
export function describeCopyStyle(value: string): string {
  const style = findCopyStyle(value);
  return style ? `${style.label}（${style.prompt}）` : `风格代号「${value}」`;
}
