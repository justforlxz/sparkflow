/**
 * 创作任务的常量：阶段名、状态枚举、错误码、超时与轮询间隔（AGENTS.md 硬性规则 1：
 * 枚举与文案集中在这里，不写死在 runner、路由或界面里）。
 *
 * 视觉方向与文案风格的可选值不在这里：它们分别由图片创作（N6）与文案创作（N7）模块的
 * `styles.ts` 登记，本模块只存任务提交上来的 key。
 */

/** 一个任务固定两条阶段，按执行顺序排列（docs/prd/04-generation-task.md「阶段与状态」）。 */
export const STAGE_NAMES = ["image", "copy"] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_LABELS: Record<StageName, string> = {
  image: "生图阶段",
  copy: "文案阶段",
};

export const STAGE_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

/** 任务状态是派生值，不落库（docs/prd/04「阶段与状态」判定表）。 */
export const TASK_STATUSES = ["running", "succeeded", "partial", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  running: "执行中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
};

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
};

/** 阶段错误的业务子码（`generation_stage.error.code`）。上游失败码由各阶段处理器自己给出。 */
export const STAGE_ERROR_CODES = {
  /** 服务重启时把残留的 running 记为失败（docs/prd/04 MUST 3、AC-04-10）。 */
  serverRestarted: "SERVER_RESTARTED",
  /** 单任务总超时（docs/prd/04 SHOULD）。 */
  timeout: "TIMEOUT",
  /** 该阶段没有注册处理器：N6 / N7 接入真实实现之前，真实适配器下就是这个状态。 */
  handlerMissing: "STAGE_HANDLER_MISSING",
  /** 处理器抛出的不是带业务码的错误。 */
  stageFailed: "STAGE_FAILED",
  /** 文案阶段找不到生图阶段建好的结果行（正常情况下不会发生）。 */
  resultMissing: "RESULT_MISSING",
  /** 处理器返回的阶段与它注册的阶段不一致（编程错误）。 */
  outcomeMismatch: "STAGE_OUTCOME_MISMATCH",
  /** 执行时读不到资源夹（多半是任务跑到一半资源夹被删，外键级联已把阶段行删掉）。 */
  collectionMissing: "COLLECTION_MISSING",
} as const;

export const TASK_ERROR_CODES = {
  /** 重试时没有失败阶段（docs/prd/04 MUST、AC-04-8、AC-05-12）。 */
  noFailedStage: "NO_FAILED_STAGE",
} as const;

/** 单任务总超时默认 15 分钟（docs/prd/04 SHOULD）；runner 允许注入更短的值便于验收。 */
export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;

/** worker 轮询间隔 1–2 秒（docs/prd/04 SHOULD）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/** 目标张数范围。PRD 05 以 9 张（4+4+1，三批）为例，上限按三批取。 */
export const MIN_IMAGE_COUNT = 1;
export const MAX_IMAGE_COUNT = 9;

/** 视觉方向 / 文案风格是短 key，不含描述正文（描述在各自模块的 styles.ts）。 */
export const MAX_STYLE_LENGTH = 40;

export const MAX_EXTRA_PROMPT_LENGTH = 1000;

/** 阶段错误消息入库前的截断长度，避免把整段上游响应塞进数据库。 */
export const MAX_ERROR_MESSAGE_LENGTH = 1000;

/** 生成图片存储子目录（docs/architecture.md「文件」）。 */
export const GENERATED_STORAGE_PREFIX = "generated-assets";

/**
 * 编辑结果的输入护栏（docs/prd/07 MUST 3）。标签数量与文案解析保持同一口径
 * （docs/prd/06：最多 10 个）。
 */
export const MAX_RESULT_TITLE_LENGTH = 200;
export const MAX_RESULT_BODY_LENGTH = 5000;
export const MAX_RESULT_TAG_LENGTH = 30;

/** 任务列表与任务详情页的文案（AGENTS.md 硬性规则 1：文案集中在这里）。 */
export const TASK_COPY = {
  listTitle: "创作任务",
  listSubtitle: "每次创作的两个阶段各自的状态、失败原因与重试入口都在这里。",
  emptyList: "还没有创作任务。创建一个资源夹，然后开始 AI 创作。",
  listAction: "查看资源夹",
  detailAction: "详情",
  viewResultAction: "查看结果",
  /** 结果为 `partial`（文案阶段失败）时结果入口的文案：图片确实生成了。 */
  viewImagesAction: "查看生成图片",
  backToList: "← 创作任务",
  retryAction: "重试",
  regenerateAction: "重新生成",
  regenerateConfirmTitle: "重新生成？",
  regenerateConfirmBody: "将重新执行生图与文案两个阶段并产生新结果，旧任务与旧结果会保留。",
  confirmAction: "确认重新生成",
  cancelAction: "取消",
  createdAtLabel: "创建时间",
  paramsLabel: "创作参数",
  imageCountLabel: "目标张数",
  visualStyleLabel: "视觉方向",
  copyStyleLabel: "文案风格",
  extraPromptLabel: "补充要求",
  stageSection: "执行阶段",
  stageAttemptsLabel: "执行次数",
  stageErrorLabel: "失败原因",
  stageFinishedLabel: "完成时间",
  agentSection: "Agent 配置快照",
  noResult: "该任务还没有生成结果。",
  retryFailed: "重试失败",
  regenerateFailed: "重新生成失败",
  refreshFailed: "刷新任务状态失败",
} as const;

/** 结果页签与结果编辑的文案（docs/prd/07-results.md）。 */
export const RESULT_COPY = {
  tabLabel: "AI 创作结果",
  emptyList: "这个资源夹还没有创作结果。",
  emptyListAction: "开始 AI 创作",
  copyFailedHint: "文案阶段失败，可重试或手动补写",
  retryAction: "重试文案阶段",
  editAction: "编辑",
  deleteAction: "删除",
  saveAction: "保存",
  cancelAction: "取消",
  editTitle: "编辑结果",
  deleteConfirmTitle: "删除这个结果？",
  deleteConfirmBody: "该结果的发布记录会一并删除，原始素材不受影响。",
  confirmDelete: "确认删除",
  titleLabel: "标题",
  bodyLabel: "正文",
  tagsLabel: "标签",
  tagsHint: "用逗号或换行分隔",
  visualStyleLabel: "视觉风格",
  generatedAtLabel: "生成日期",
  imageCountLabel: "图片",
  openLarge: "查看大图",
  saveFailed: "保存失败",
  saveSucceeded: "结果已保存",
  deleteFailed: "删除失败",
  retryFailed: "重试失败",
  retryQueued: "文案阶段已重新排队，完成后刷新页面查看。",
} as const;

/** 开始创作弹窗的文案（参数与接口见 docs/prd/04「数据与接口」）。 */
export const CREATION_COPY = {
  action: "开始 AI 创作",
  title: "开始 AI 创作",
  intro: "两个 Agent 都已就绪时才能开始；生图与文案会各跑一个阶段。",
  visualStyleLabel: "视觉方向",
  copyStyleLabel: "文案风格",
  imageCountLabel: "目标张数",
  extraPromptLabel: "补充要求",
  extraPromptPlaceholder: "想强调的角度、必须出现的元素等，可留空",
  submitAction: "开始创作",
  cancelAction: "取消",
  submitFailed: "开始创作失败",
} as const;
