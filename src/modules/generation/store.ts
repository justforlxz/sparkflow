/**
 * 持久化端口（`TaskStore`）与文件端口（`ResultAssetWriter`）。
 *
 * runner 只依赖这两个接口：真实实现在 `repo.ts` 与 `storage.ts`，单测用内存实现替代，
 * 这样「产出写入时机」「重启恢复」「重试复用结果」这些语义可以脱离数据库断言（见 runner.test.ts）。
 */
import type { StageName } from "./constants";
import type {
  ClaimedStage,
  CopyContent,
  GeneratedImage,
  ResultAssetInput,
  ResultRecord,
  StageErrorRecord,
  TaskAgentSnapshots,
  TaskWithStages,
} from "./types";

export interface NewTaskInput {
  collectionId: string;
  visualStyle: string;
  copyStyle: string;
  imageCount: number;
  extraPrompt: string | null;
  agentSnapshot: TaskAgentSnapshots;
}

export interface NewResultInput {
  id: string;
  taskId: string;
  collectionId: string;
  visualStyle: string;
  assets: ResultAssetInput[];
}

export interface CollectionUsage {
  tasks: number;
  /** 还在推进的任务数（派生状态为 running）；资源夹「生成中」与「禁止改图」都用它。 */
  activeTasks: number;
  results: number;
}

export interface TaskStore {
  createTask(input: NewTaskInput): Promise<TaskWithStages>;
  findTask(taskId: string): Promise<TaskWithStages | null>;
  listTasks(): Promise<TaskWithStages[]>;
  /** 取下一个可执行阶段并原子地置为 running；没有可跑的就是 null（ADR 0002：一次一个任务）。 */
  claimNextStage(now: Date): Promise<ClaimedStage | null>;
  /** 只更新仍处于 running 的阶段行；返回受影响行数，0 表示这一行已不存在或已被改判。 */
  markStageSucceeded(
    stageId: string,
    meta: Record<string, unknown> | null,
    now: Date,
  ): Promise<number>;
  markStageFailed(
    stageId: string,
    error: StageErrorRecord,
    meta: Record<string, unknown> | null,
    now: Date,
  ): Promise<number>;
  /** 启动时把残留的 running 记为失败（AC-04-10）；返回处理条数。 */
  failRunningStages(error: StageErrorRecord, now: Date): Promise<number>;
  createResult(input: NewResultInput): Promise<void>;
  /** 已有结果行时替换它的生成图片（重试生图、异常数据恢复都走这里，避免撞上 task_id 唯一约束）。 */
  replaceResultAssets(resultId: string, assets: readonly ResultAssetInput[]): Promise<void>;
  findResultByTask(taskId: string): Promise<ResultRecord | null>;
  /** 文案阶段成功后补齐文案，复用生图阶段建好的结果行（docs/prd/04 MUST 4）。 */
  updateResultCopy(resultId: string, copy: CopyContent): Promise<void>;
  /**
   * 重试：把指定阶段从 failed 置回 queued 且 attempts 加一，不动已成功的阶段（ADR 0005）。
   * 返回受影响行数；0 表示这些阶段已经被别的请求重新排队（并发重试只能有一条成功）。
   */
  resetStages(taskId: string, stages: readonly StageName[]): Promise<number>;
  countCollectionUsage(collectionId: string): Promise<CollectionUsage>;
}

export type StoredImage = ResultAssetInput;

export interface ResultAssetWriter {
  /** 把图片写进 `<UPLOAD_DIR>/generated-assets/<resultId>/`，返回落库需要的 storage_key。 */
  write(resultId: string, images: readonly GeneratedImage[]): Promise<StoredImage[]>;
}
