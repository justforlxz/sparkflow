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

/** 单任务总超时默认 45 分钟（docs/prd/04 SHOULD）：一图对一图后上游调用次数随原图量增长。 */
export const DEFAULT_TASK_TIMEOUT_MS = 45 * 60 * 1000;

/** worker 轮询间隔 1–2 秒（docs/prd/04 SHOULD）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * 界面轮询未终态任务的间隔（docs/prd/07 MUST 4）：任务列表与资源夹详情的创作区共用同一个值，
 * 两处各写一份迟早会漂移。
 */
export const STAGE_POLL_INTERVAL_MS = 3000;

// 目标张数已取消：成品张数 = 这次的原图张数（ADR 0008），没有可配置的上下限。

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
/**
 * 一次发布最多勾选几张成品图：只是防超长输入的护栏，不是产品规则
 * （成品张数 = 原图张数，没有产品上限，见 ADR 0008）。
 */
export const MAX_SELECTED_ASSET_IDS = 50;

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
  /**
   * 失败阶段旁的重试说明（MKACG-904）：重试按 ADR 0005 只重跑失败阶段，
   * 配置仍取自任务创建时的快照（docs/prd/05 MUST 5），必须在用户点之前讲清楚。
   */
  retryUsesSnapshotHint: "重试沿用该任务创建时的 Agent 配置；配置已经改过的话，请用「重新生成」。",
  /** 快照与当前 Agent 配置已经不同：样式换成警示，并点出差在哪里（MKACG-904 SHOULD）。 */
  retrySnapshotChangedHint:
    "该任务的快照用的模型或网关与当前 Agent 配置不同：重试仍会沿用创建时的配置，改好配置后请用「重新生成」。",
  regenerateConfirmTitle: "重新生成？",
  regenerateConfirmBody: "将重新执行生图与文案两个阶段并产生新结果，旧任务与旧结果会保留。",
  /**
   * 重新生成弹窗里的提取要求选择与旧任务说明（ADR 0009）。
   * 旧任务存的是已删除的视觉方向 key，原样回传必然 VALIDATION_FAILED，所以必须让用户重选。
   */
  regenerateLegacyRequirementNote:
    "该任务创建时选的是旧的视觉方向，已经不再使用，请重新选择提取要求；提取目标取自资源夹，缺失时请先到资源夹里填写。",
  confirmAction: "确认重新生成",
  cancelAction: "取消",
  createdAtLabel: "创建时间",
  paramsLabel: "创作参数",
  extractTargetLabel: "提取目标",
  expectedImageCountLabel: "预计提取图张数",
  /** 提取要求取代原来的「视觉方向」（ADR 0009）。 */
  extractRequirementLabel: "提取要求",
  copyStyleLabel: "文案风格",
  extraPromptLabel: "补充要求",
  stageSection: "执行阶段",
  stageAttemptsLabel: "执行次数",
  stageErrorLabel: "失败原因",
  /** 生图阶段有原图失败但仍有成品：说明缺了哪几张，不用「失败原因」吓人。 */
  stagePartialErrorLabel: "部分原图失败",
  stageProgressLabel: "正在生图",
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
  generatedImageCountLabel: "提取图",
  /** 结果所属任务创建时固化的提取目标（ADR 0009）。 */
  extractTargetLabel: "提取目标",
  /**
   * 视觉提取降级的两种原因（docs/prd/06「视觉提取」）：文案照常生成，但没拿到照片内容时必须标注。
   * 两句都要说清下一步去哪改，不能把原因归到文案模型上（它已经不参与判定）。
   */
  copyVisualDegradedNoGateway: "未配置图片理解网关，文案未包含照片内容；请到设置页添加 magpie-vision 网关",
  copyVisualDegradedFailed: "图片理解识别失败，文案未包含照片内容；可重试文案阶段",
  openLarge: "查看大图",
  saveFailed: "保存失败",
  saveSucceeded: "结果已保存",
  deleteFailed: "删除失败",
  retryFailed: "重试失败",
  retryQueued: "文案阶段已重新排队，完成后刷新页面查看。",
} as const;

/**
 * 资源夹详情「创作」区的文案（docs/prd/07-results.md「资源夹详情的「创作」区」）。
 * 折叠摘要只写状态，不写标题正文：折叠态不能把文案露出来。
 */
export const CREATION_SECTION_COPY = {
  title: "创作",
  description: "这个资源夹的创作进度与结果都在这里，不用跳到任务列表。",
  runningTitle: "正在创作",
  troubledTitle: "创作未完成",
  resultsTitle: "创作结果",
  expandAction: "展开",
  collapseAction: "收起",
  /** 成品图对应的原图编号前缀（「原图 2」），与 `sortOrder` 一起形成一图对一图的对照（ADR 0008）。 */
  sourceAssetLabelPrefix: "原图",
  /** 原图被解除关联后不猜编号，如实说明。 */
  noSourceAssetLabel: "原图已解除关联",
  summaryGeneratedAt: "生成于",
  summaryImageCountLabel: "张",
  /** 折叠摘要里的提取目标（ADR 0009）：历史结果没有这一项，不显示。 */
  extractTargetLabel: "提取目标",
  copyFailedLabel: "文案阶段失败",
  retryQueued: "已重新排队，完成后这里会自动刷新。",
  pollFailed: "刷新创作进度失败，稍后会自动重试。",
  emptyMessage: "这个资源夹还没有开始 AI 创作。",
  emptyHint: "上传原图后点「开始 AI 创作」，进度与结果会直接出现在这里。",
} as const;

/** 开始创作弹窗的文案（参数与接口见 docs/prd/04「数据与接口」）。 */
export const CREATION_COPY = {
  action: "开始 AI 创作",
  title: "开始 AI 创作",
  intro: "两个 Agent 都已就绪时才能开始；每张原图各提取一张素材图，提取与文案会各跑一个阶段。",
  /** 提取目标只读显示：它在资源夹上维护，发起创作时必填（ADR 0009）。 */
  extractTargetLabel: "提取目标",
  /** 提取要求取代原来的「视觉方向」（ADR 0009）。 */
  extractRequirementLabel: "提取要求",
  copyStyleLabel: "文案风格",
  expectedImageCountLabel: "预计提取图张数",
  /** 张数由原图决定，界面只显示结果、不给输入框（ADR 0008）。 */
  expectedImageCountHint: "每张原图各提取一张素材图，张数取自原始素材",
  extraPromptLabel: "补充要求",
  extraPromptPlaceholder: "想强调的角度、必须出现的元素等，可留空",
  submitAction: "开始创作",
  cancelAction: "取消",
  submitFailed: "开始创作失败",
  /** 0 张原图时点「开始 AI 创作」只给这一句提示，不发请求（AC-01-2）。 */
  needsImages: "先上传原始素材",
} as const;
