/**
 * 文案创作的常量（docs/prd/06-copy-generation.md）。
 *
 * 失败码在这里集中声明，不写死在适配器与解析函数里：处理器把它们交给 `StageError`，
 * runner 原样写进 `copy_version.error.code`（AGENTS.md 硬性规则 1）。
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

/** 模型输出的标题超过 40 字截断并记日志（docs/prd/06 MAY）。与编辑接口的 200 字上限是两件事。 */
export const MAX_COPY_TITLE_LENGTH = 40;

/** 单次文本请求的超时；任务总超时仍是 15 分钟（docs/prd/04 SHOULD）。 */
export const DEFAULT_COPY_TIMEOUT_MS = 60_000;

/** Anthropic Messages 必须给 `max_tokens`，取一个够写完一篇笔记的值。 */
export const ANTHROPIC_MAX_TOKENS = 4096;

/* ---------- 文案版本的作业状态（docs/prd/12「数据模型」） ---------- */

export const COPY_VERSION_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export type CopyVersionStatus = (typeof COPY_VERSION_STATUSES)[number];

export const COPY_VERSION_STATUS_LABELS: Record<CopyVersionStatus, string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
};

/** 作业层（不是上游）的失败子码：写进 `copy_version.error.code`。 */
export const COPY_JOB_ERROR_CODES = {
  /** 服务重启时把残留的 running 记为失败。 */
  serverRestarted: "SERVER_RESTARTED",
  /** 单次生成总超时。 */
  timeout: "COPY_TIMEOUT",
  /** 处理器抛出的不是带业务码的错误。 */
  jobFailed: "COPY_FAILED",
  /** 执行时读不到资源夹或选中的素材都不在了。 */
  inputMissing: "COPY_INPUT_MISSING",
  /** 执行时文案 Agent 不可用（停用、未绑定、网关被删）。 */
  agentUnavailable: "COPY_AGENT_UNAVAILABLE",
} as const;

/** 单次文案生成的总超时（一个文本请求，比布尔；docs/prd/06 SHOULD）。 */
export const DEFAULT_COPY_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** 文案版本与生成入口的界面文案（AGENTS.md 硬性规则 1）。 */
export const COPY_VERSION_COPY = {
  listTitle: "文案版本",
  emptyList: "这个资源夹还没有文案版本。",
  generateAction: "生成文案",
  generatingLabel: "生成中",
  versionLabel: "版本",
  selectedCountLabel: "素材",
  /** 素材被删除后版本里仍保留 id：显示成占位而不是消失（MUST 4、AC-LIB-6）。 */
  deletedAssetLabel: "已删除素材",
  editAction: "编辑",
  saveAction: "保存",
  saveFailed: "保存失败",
  generateFailed: "生成文案失败",
  shareUnavailable: "分享功能不可用",
  /**
   * 视觉提取被降级的两种原因（docs/prd/06「视觉提取」）：文案照常生成，但没拿到素材内容时必须标注。
   * 两句都要说清下一步去哪改，不能把原因归到文案模型上（它已经不参与判定）。
   */
  visualDegradedNoGateway: "未配置图片理解网关，文案未包含素材内容；请到设置页添加 magpie-vision 网关",
  visualDegradedFailed: "图片理解识别失败，文案未包含素材内容；可重新生成文案",
  copyFailedHint: "生成失败，可重新生成",
} as const;
