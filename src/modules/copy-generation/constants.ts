/**
 * 文案创作的常量（docs/prd/06-copy-generation.md）。
 *
 * 失败码在这里集中声明，不写死在适配器与解析函数里：阶段处理器把它们交给 `StageError`，
 * runner 原样写进 `generation_stage.error.code`（AGENTS.md 硬性规则 1）。
 */

export const COPY_ERROR_CODES = {
  /** 上游在超时时间内没有响应。 */
  timeout: "COPY_TIMEOUT",
  /** 鉴权失败（401/403），或网关密钥不可用。 */
  auth: "COPY_AUTH",
  /** 回包不是可解析的 JSON，或结构里没有文本。 */
  format: "COPY_FORMAT",
  /** 解析成功但标题为空（docs/prd/06「解析规则」5、AC-07-7）。 */
  empty: "COPY_EMPTY",
  /** 上游拒绝了请求，或这一阶段本身不具备执行条件（模型未绑定、接口形状不支持）。 */
  rejected: "COPY_REJECTED",
} as const;

export type CopyErrorCode = (typeof COPY_ERROR_CODES)[keyof typeof COPY_ERROR_CODES];

/** 话题标签最多入库 10 个（docs/prd/06「解析规则」3、AC-07-8）。 */
export const MAX_TAGS = 10;

/** 标题超过 40 字截断并记日志（docs/prd/06 MAY）。 */
export const MAX_TITLE_LENGTH = 40;

/** 单次文本请求的超时；任务总超时仍是 15 分钟（docs/prd/04 SHOULD）。 */
export const DEFAULT_COPY_TIMEOUT_MS = 60_000;

/** Anthropic Messages 必须给 `max_tokens`，取一个够写完一篇笔记的值。 */
export const ANTHROPIC_MAX_TOKENS = 4096;
