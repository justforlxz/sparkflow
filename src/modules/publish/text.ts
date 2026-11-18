/**
 * 复制到剪贴板的固定文案格式（docs/prd/08 MUST 4、AC-08-2、AC-09-9）：
 * 「标题 + 空行 + 正文 + 空行 + `#标签` 空格分隔」。
 *
 * 段与段之间只有一个空行，粘到小红书编辑器里正好是标题、正文、话题三块。
 * `parsePublishText` 是同一格式的反向解析，AC-09-9 用它断言「复制得到的文本能被解析回三段」；
 * 它也是这个格式的唯一说明，改格式时两处一起改。
 */

export interface PublishTextContent {
  title: string;
  body: string;
  tags: readonly string[];
}

/** 标签统一成 `#标签` 形式：去掉用户自己带的 `#`、空项与重复项（与结果编辑同一口径）。 */
function normalizeTags(tags: readonly string[]): string[] {
  const cleaned = tags
    .map((tag) => tag.trim().replace(/^#/, "").trim())
    .filter((tag) => tag.length > 0);
  return [...new Set(cleaned)];
}

/**
 * 标签输入框（逗号或换行分隔）的解析。结果编辑弹窗与发布准备弹窗共用这一份，
 * 两处的「去 `#`、去空项、去重复」规则不会各写一套。
 */
export function parseTagInput(value: string): string[] {
  return normalizeTags(value.split(/[,，\n]/));
}

function tagLine(tags: readonly string[]): string {
  return normalizeTags(tags)
    .map((tag) => `#${tag}`)
    .join(" ");
}

/** 三段按顺序拼成一个空行分隔的文本；空段直接省略，不留连续空行。 */
export function formatPublishText(content: PublishTextContent): string {
  return [content.title.trim(), content.body.trim(), tagLine(content.tags)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export interface ParsedPublishText {
  title: string;
  body: string;
  tags: string[];
}

/**
 * `formatPublishText` 的反向解析：首行是标题，末行以 `#` 开头时是标签行，其余是正文。
 *
 * 约定正文最后一行不以 `#` 开头（正文是文案，不是话题），因此不必猜测标签从哪里开始。
 */
export function parsePublishText(text: string): ParsedPublishText {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const title = (lines.shift() ?? "").trim();

  // 标题与正文之间只有一个空行：逐个去掉，正文内部的空行保留。
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();

  let tags: string[] = [];
  const last = lines.at(-1);
  if (last !== undefined && last.trim().startsWith("#")) {
    tags = normalizeTags(last.trim().split(/\s+/));
    lines.pop();
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  }

  return { title, body: lines.join("\n").trim(), tags };
}
