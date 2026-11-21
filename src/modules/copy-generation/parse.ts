/**
 * 文案结构化输出的解析与清洗（docs/prd/06-copy-generation.md「输出结构」）。
 *
 * 纯函数，不碰网络与数据库：适配器把模型原文交进来，这里要么给出干净的三个字段，
 * 要么抛 `StageError` 让这次生成失败（runner 据此记 `COPY_FORMAT` / `COPY_EMPTY`，不写脏数据）。
 */
import { logger } from "@/lib/logger";
import { COPY_ERROR_CODES, MAX_COPY_TITLE_LENGTH, MAX_TAGS } from "./constants";
import { StageError } from "@/lib/job-failure";
import type { CopyContent } from "./types";

/** 允许模型把 JSON 包在 ```json 围栏里；围栏语言标记可省略。 */
const CODE_FENCE = /```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/;

/** 标签前面的 `#`（半角与全角都认）。 */
const LEADING_HASH = /^[#＃]+/;

function formatError(message: string): StageError {
  return new StageError(COPY_ERROR_CODES.format, message);
}

export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = CODE_FENCE.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/** 数组或 `#标签 #标签` 字符串两种形态，统一成不带 `#`、去重、最多 10 个的数组。 */
export function normalizeTags(value: unknown): string[] {
  let candidates: string[];

  if (typeof value === "string") {
    candidates = value.split(/[\s,，、]+/);
  } else if (Array.isArray(value)) {
    candidates = value.filter((item): item is string => typeof item === "string");
  } else if (value === undefined || value === null) {
    return [];
  } else {
    throw formatError("tags 字段既不是数组也不是字符串");
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const candidate of candidates) {
    const tag = candidate.replace(LEADING_HASH, "").trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

/** 去空白；超过 40 字按字符截断并记一条告警（MAY：长度截断保护）。 */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const title = value.trim();
  const characters = Array.from(title);
  if (characters.length <= MAX_COPY_TITLE_LENGTH) return title;

  logger.warn("文案标题超过上限，已截断", {
    limit: MAX_COPY_TITLE_LENGTH,
    originalLength: characters.length,
  });
  return characters.slice(0, MAX_COPY_TITLE_LENGTH).join("");
}

/** 保留换行，把连续空行压缩到最多一个空行。 */
export function normalizeBody(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 解析模型回包。失败分类：
 * - 剥掉围栏后不是 JSON、或不是对象 → `COPY_FORMAT`；
 * - 标题为空 → `COPY_EMPTY`（AC-07-7）。
 */
export function parseCopyContent(raw: string): CopyContent {
  const payload = stripCodeFence(raw);
  if (!payload) throw formatError("模型没有返回内容");

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw formatError("模型返回的不是可解析的 JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw formatError("模型返回的 JSON 不是对象");
  }

  const record = parsed as Record<string, unknown>;
  const title = normalizeTitle(record.title);
  const body = normalizeBody(record.body);
  const tags = normalizeTags(record.tags);

  if (!title) {
    throw new StageError(COPY_ERROR_CODES.empty, "模型没有给出标题（title 为空）");
  }

  return { title, body, tags };
}
