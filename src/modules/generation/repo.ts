/**
 * 创作任务的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 这里只有查询与写入；状态判定在 `derive.ts`，执行编排在 `runner.ts`。
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { STAGE_NAMES, type StageName, type StageStatus } from "./constants";
import { deriveTaskStatus, type StageState } from "./derive";
import type { CollectionUsage, NewResultInput, NewTaskInput, TaskStore } from "./store";
import type {
  ClaimedStage,
  CopyContent,
  ResultAssetInput,
  ResultRecord,
  StageErrorRecord,
  StageRecord,
  TaskAgentSnapshots,
  TaskRecord,
  TaskWithStages,
} from "./types";

const STAGE_FIELDS = {
  id: true,
  taskId: true,
  stage: true,
  status: true,
  attempts: true,
  error: true,
  meta: true,
  startedAt: true,
  finishedAt: true,
} as const;

const TASK_FIELDS = {
  id: true,
  collectionId: true,
  visualStyle: true,
  copyStyle: true,
  imageCount: true,
  extraPrompt: true,
  agentSnapshot: true,
  createdAt: true,
} as const;

const TASK_WITH_STAGES = {
  ...TASK_FIELDS,
  stages: { select: STAGE_FIELDS },
} as const;

interface RawStageRow {
  id: string;
  taskId: string;
  stage: string;
  status: string;
  attempts: number;
  error: unknown;
  meta: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface RawTaskRow {
  id: string;
  collectionId: string;
  visualStyle: string;
  copyStyle: string;
  imageCount: number;
  extraPrompt: string | null;
  agentSnapshot: unknown;
  createdAt: Date;
}

interface RawTaskWithStagesRow extends RawTaskRow {
  stages: RawStageRow[];
}

function toStageRecord(row: RawStageRow): StageRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    stage: row.stage as StageName,
    status: row.status as StageStatus,
    attempts: row.attempts,
    error: (row.error as StageErrorRecord | null) ?? null,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toTaskRecord(row: RawTaskRow): TaskRecord {
  return {
    id: row.id,
    collectionId: row.collectionId,
    visualStyle: row.visualStyle,
    copyStyle: row.copyStyle,
    imageCount: row.imageCount,
    extraPrompt: row.extraPrompt,
    agentSnapshot: row.agentSnapshot as TaskAgentSnapshots,
    createdAt: row.createdAt,
  };
}

function toTaskWithStages(row: RawTaskWithStagesRow): TaskWithStages {
  return { task: toTaskRecord(row), stages: row.stages.map(toStageRecord) };
}

/** 可空的 jsonb 列：`null` 写 SQL NULL，其余按 JSON 写入。 */
function jsonOrDbNull(value: object | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue);
}

/**
 * 创建任务与两条阶段于同一次嵌套写入：不会出现「任务在、阶段缺」。
 *
 * id 与创建时间在应用侧生成，返回值也直接由入参拼出（不回头再查一次）：
 * 创建接口的响应因此一定是「两条阶段都排队」的初始状态，不会因为 worker 抢跑而变成 running。
 */
export async function createTask(input: NewTaskInput): Promise<TaskWithStages> {
  const task: TaskRecord = {
    id: randomUUID(),
    collectionId: input.collectionId,
    visualStyle: input.visualStyle,
    copyStyle: input.copyStyle,
    imageCount: input.imageCount,
    extraPrompt: input.extraPrompt,
    agentSnapshot: input.agentSnapshot,
    createdAt: new Date(),
  };
  // 已排入执行队列的尝试次数：创建即第 1 次，每次重试加 1（docs/prd/04 AC-04-6）。
  const stages: StageRecord[] = STAGE_NAMES.map((stage) => ({
    id: randomUUID(),
    taskId: task.id,
    stage,
    status: "queued",
    attempts: 1,
    error: null,
    meta: null,
    startedAt: null,
    finishedAt: null,
  }));

  await getDb().generationTask.create({
    data: {
      id: task.id,
      collectionId: task.collectionId,
      visualStyle: task.visualStyle,
      copyStyle: task.copyStyle,
      imageCount: task.imageCount,
      extraPrompt: task.extraPrompt,
      agentSnapshot: task.agentSnapshot as unknown as Prisma.InputJsonValue,
      createdAt: task.createdAt,
      stages: {
        create: stages.map((stage) => ({
          id: stage.id,
          stage: stage.stage,
          status: stage.status,
          attempts: stage.attempts,
        })),
      },
    },
    select: { id: true },
  });

  return { task, stages };
}

export async function findTask(taskId: string): Promise<TaskWithStages | null> {
  const row = await getDb().generationTask.findUnique({
    where: { id: taskId },
    select: TASK_WITH_STAGES,
  });
  return row ? toTaskWithStages(row as RawTaskWithStagesRow) : null;
}

export async function listTasks(): Promise<TaskWithStages[]> {
  const rows = await getDb().generationTask.findMany({
    orderBy: { createdAt: "desc" },
    select: TASK_WITH_STAGES,
  });
  return (rows as RawTaskWithStagesRow[]).map(toTaskWithStages);
}

/**
 * 出队：优先取「生图阶段排队」的任务，其次取「生图已成功、文案排队」的任务；
 * 同一时刻只让一个阶段变成 running（ADR 0002）。
 * 生图失败时文案阶段保持 queued 且不被选中（docs/prd/04「阶段与状态」）。
 */
export async function claimNextStage(now: Date): Promise<ClaimedStage | null> {
  const db = getDb();
  const select = { ...STAGE_FIELDS, task: { select: TASK_WITH_STAGES } } as const;

  const [imageQueued, copyQueued] = await Promise.all([
    db.generationStage.findFirst({
      where: {
        stage: "image",
        status: "queued",
        task: { stages: { none: { status: "running" } } },
      },
      orderBy: { task: { createdAt: "asc" } },
      select,
    }),
    db.generationStage.findFirst({
      where: {
        stage: "copy",
        status: "queued",
        task: {
          stages: {
            some: { stage: "image", status: "succeeded" },
            none: { status: "running" },
          },
        },
      },
      orderBy: { task: { createdAt: "asc" } },
      select,
    }),
  ]);

  const candidate = [imageQueued, copyQueued]
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => left.task.createdAt.getTime() - right.task.createdAt.getTime())[0];
  if (!candidate) return null;

  // 条件更新即认领：并发时只有一条能把 queued 改成 running。
  const { count } = await db.generationStage.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: { status: "running", startedAt: now },
  });
  if (count === 0) return null;

  const stage: StageRecord = { ...toStageRecord(candidate), status: "running", startedAt: now };
  const stages = candidate.task.stages.map((row) =>
    row.id === stage.id ? stage : toStageRecord(row),
  );
  return { task: toTaskRecord(candidate.task), stages, stage };
}

export async function markStageSucceeded(
  stageId: string,
  meta: Record<string, unknown> | null,
  now: Date,
): Promise<number> {
  const { count } = await getDb().generationStage.updateMany({
    where: { id: stageId, status: "running" },
    data: { status: "succeeded", finishedAt: now, error: Prisma.DbNull, meta: jsonOrDbNull(meta) },
  });
  return count;
}

export async function markStageFailed(
  stageId: string,
  error: StageErrorRecord,
  meta: Record<string, unknown> | null,
  now: Date,
): Promise<number> {
  const { count } = await getDb().generationStage.updateMany({
    where: { id: stageId, status: "running" },
    data: { status: "failed", finishedAt: now, error: jsonOrDbNull(error), meta: jsonOrDbNull(meta) },
  });
  return count;
}

/** 服务启动时清理残留状态：running → failed（`SERVER_RESTARTED`），queued 保持待跑（AC-04-10）。 */
export async function failRunningStages(error: StageErrorRecord, now: Date): Promise<number> {
  const { count } = await getDb().generationStage.updateMany({
    where: { status: "running" },
    data: { status: "failed", finishedAt: now, error: jsonOrDbNull(error), meta: Prisma.DbNull },
  });
  return count;
}

/** 生图阶段成功：建结果行与生成图片行，两者在同一次嵌套写入里。 */
export async function createResult(input: NewResultInput): Promise<void> {
  await getDb().generationResult.create({
    data: {
      id: input.id,
      taskId: input.taskId,
      collectionId: input.collectionId,
      visualStyle: input.visualStyle,
      assets: {
        create: input.assets.map((asset) => ({
          storageKey: asset.storageKey,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          sortOrder: asset.sortOrder,
          width: asset.width,
          height: asset.height,
        })),
      },
    },
    select: { id: true },
  });
}

const RESULT_SELECT = {
  id: true,
  taskId: true,
  collectionId: true,
  title: true,
  body: true,
  tags: true,
  visualStyle: true,
  createdAt: true,
  assets: {
    select: { id: true, fileName: true, mimeType: true, sortOrder: true },
    orderBy: { sortOrder: "asc" },
  },
} as const;

interface RawResultRow {
  id: string;
  taskId: string;
  collectionId: string;
  title: string | null;
  body: string | null;
  tags: string[];
  visualStyle: string;
  createdAt: Date;
  assets: { id: string; fileName: string; mimeType: string; sortOrder: number }[];
}

function toResultRecord(row: RawResultRow): ResultRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    collectionId: row.collectionId,
    title: row.title,
    body: row.body,
    tags: row.tags,
    visualStyle: row.visualStyle,
    createdAt: row.createdAt,
    assets: row.assets,
  };
}

export async function findResultByTask(taskId: string): Promise<ResultRecord | null> {
  const row = await getDb().generationResult.findUnique({
    where: { taskId },
    select: RESULT_SELECT,
  });
  return row ? toResultRecord(row as RawResultRow) : null;
}

/**
 * 替换结果行的生成图片：先删旧行再写新行。
 *
 * 只在「任务已有结果行、生图阶段又要重跑」时用到 —— 正常路径不会出现这种状态，
 * 但异常中断后如果硬要新建结果行，会撞上 `generation_result.task_id` 的唯一约束，
 * 让整个任务永久无法重试成功。旧图片文件留在磁盘上（与资源夹模块同一条取舍：不引入回收）。
 */
export async function replaceResultAssets(
  resultId: string,
  assets: readonly ResultAssetInput[],
): Promise<void> {
  const db = getDb();
  await db.$transaction([
    db.generatedAsset.deleteMany({ where: { resultId } }),
    ...(assets.length > 0
      ? [
          db.generatedAsset.createMany({
            data: assets.map((asset) => ({
              resultId,
              storageKey: asset.storageKey,
              fileName: asset.fileName,
              mimeType: asset.mimeType,
              sortOrder: asset.sortOrder,
              width: asset.width,
              height: asset.height,
            })),
          }),
        ]
      : []),
  ]);
}

/** 文案阶段成功：补齐已有结果行的三个字段，不新建结果（MUST 4、AC-04-6）。 */
export async function updateResultCopy(resultId: string, copy: CopyContent): Promise<void> {
  await getDb().generationResult.updateMany({
    where: { id: resultId },
    data: { title: copy.title, body: copy.body, tags: copy.tags },
  });
}

/** 重试：只把失败阶段置回 queued 并让 attempts 加一，已成功阶段完全不动（ADR 0005）。 */
export async function resetStages(taskId: string, stages: readonly StageName[]): Promise<void> {
  if (stages.length === 0) return;
  await getDb().generationStage.updateMany({
    where: { taskId, stage: { in: [...stages] } },
    data: {
      status: "queued",
      attempts: { increment: 1 },
      error: Prisma.DbNull,
      meta: Prisma.DbNull,
      startedAt: null,
      finishedAt: null,
    },
  });
}

/** 资源夹侧要的任务/结果计数（docs/prd/01 的派生状态与「有运行中任务」判定）。 */
export async function countCollectionUsage(collectionId: string): Promise<CollectionUsage> {
  const db = getDb();
  const [tasks, results] = await Promise.all([
    db.generationTask.findMany({
      where: { collectionId },
      select: { stages: { select: { stage: true, status: true } } },
    }),
    db.generationResult.count({ where: { collectionId } }),
  ]);
  const activeTasks = tasks.filter(
    (task) => deriveTaskStatus(task.stages as StageState[]) === "running",
  ).length;
  return { tasks: tasks.length, activeTasks, results };
}

/* ---------- 结果页签的查询与写入（docs/prd/07-results.md） ---------- */

/** 结果连任务的两条阶段一起取：文案是否失败、能否重试都由阶段状态派生（AC-08-11）。 */
const RESULT_WITH_STAGES = {
  ...RESULT_SELECT,
  task: { select: { stages: { select: STAGE_FIELDS } } },
} as const;

interface RawResultWithStagesRow extends RawResultRow {
  task: { stages: RawStageRow[] };
}

export interface ResultWithStages {
  result: ResultRecord;
  stages: StageRecord[];
}

function toResultWithStages(row: RawResultWithStagesRow): ResultWithStages {
  return { result: toResultRecord(row), stages: row.task.stages.map(toStageRecord) };
}

/** 结果按资源夹隔离查询（docs/prd/07 MUST 6），按创建时间倒序（MUST 1）。 */
export async function listResultsByCollection(collectionId: string): Promise<ResultWithStages[]> {
  const rows = await getDb().generationResult.findMany({
    where: { collectionId },
    orderBy: { createdAt: "desc" },
    select: RESULT_WITH_STAGES,
  });
  return (rows as RawResultWithStagesRow[]).map(toResultWithStages);
}

export async function findResultWithStages(resultId: string): Promise<ResultWithStages | null> {
  const row = await getDb().generationResult.findUnique({
    where: { id: resultId },
    select: RESULT_WITH_STAGES,
  });
  return row ? toResultWithStages(row as RawResultWithStagesRow) : null;
}

/** 编辑只允许这四个字段：任务快照与原始素材不动（docs/prd/07 MUST NOT）。 */
export interface ResultFieldsPatch {
  title: string | null;
  body: string | null;
  tags: string[];
  visualStyle: string;
}

export async function updateResultFields(
  resultId: string,
  patch: Partial<ResultFieldsPatch>,
): Promise<boolean> {
  const { count } = await getDb().generationResult.updateMany({
    where: { id: resultId },
    data: patch,
  });
  return count > 0;
}

/** 删除整组结果：生成图片行随外键级联删除，原图与其它结果不受影响（docs/prd/07 MUST 4）。 */
export async function deleteResult(resultId: string): Promise<boolean> {
  const { count } = await getDb().generationResult.deleteMany({ where: { id: resultId } });
  return count > 0;
}

/** 鉴权读取生成图片：按结果与图片两个 id 定位，不跨结果串数据。 */
export async function findResultAsset(
  resultId: string,
  assetId: string,
): Promise<{ storageKey: string; mimeType: string } | null> {
  return getDb().generatedAsset.findFirst({
    where: { id: assetId, resultId },
    select: { storageKey: true, mimeType: true },
  });
}

/** 工作台「最近生成的内容」的一行：只取列表要用的字段与第一张生成图片。 */
export interface RecentResultRow {
  id: string;
  collectionId: string;
  title: string | null;
  createdAt: Date;
  firstAssetId: string | null;
}

const RECENT_RESULT_SELECT = {
  id: true,
  collectionId: true,
  title: true,
  createdAt: true,
  assets: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 },
} as const;

/** 最近生成的内容：按创建时间倒序取前 N 条，不加载全量（docs/prd/09 MUST 2）。 */
export async function listRecentResults(limit: number): Promise<RecentResultRow[]> {
  const rows = await getDb().generationResult.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: RECENT_RESULT_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    collectionId: row.collectionId,
    title: row.title,
    createdAt: row.createdAt,
    firstAssetId: row.assets[0]?.id ?? null,
  }));
}

/**
 * 「待发布」的结果数：有结果、还没有发布记录（docs/prd/09 MUST 1）。
 * 这是本模块自己的行上的判定（`publishRecord` 是发布模块在本表上声明的关系）。
 */
export async function countResultsWithoutPublishRecord(): Promise<number> {
  return getDb().generationResult.count({ where: { publishRecord: null } });
}

export const taskStore: TaskStore = {
  createTask,
  findTask,
  listTasks,
  claimNextStage,
  markStageSucceeded,
  markStageFailed,
  failRunningStages,
  createResult,
  replaceResultAssets,
  findResultByTask,
  updateResultCopy,
  resetStages,
  countCollectionUsage,
};
