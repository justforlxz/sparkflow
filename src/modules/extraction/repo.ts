/**
 * 提取运行与素材库的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 这里只有查询与写入；状态流转在 `runner.ts`，业务校验在 `service.ts`。
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import type { ExtractionStore } from "./store";
import type { ExtractionStatus } from "./constants";
import type {
  ExtractionErrorRecord,
  ExtractionItemInput,
  ExtractionItemRecord,
  ExtractionProgress,
  ExtractionRunRecord,
  LibraryAssetInput,
  LibraryAssetRecord,
} from "./types";

const RUN_SELECT = {
  id: true,
  collectionId: true,
  status: true,
  requirement: true,
  categories: true,
  sourceAssetIds: true,
  progress: true,
  error: true,
  extraPrompt: true,
  currentItemKey: true,
  createdAt: true,
  finishedAt: true,
} as const;

interface RawRunRow {
  id: string;
  collectionId: string;
  status: string;
  requirement: string;
  categories: string[];
  sourceAssetIds: string[];
  progress: unknown;
  error: unknown;
  extraPrompt: string | null;
  currentItemKey: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

function toRunRecord(row: RawRunRow): ExtractionRunRecord {
  return {
    id: row.id,
    collectionId: row.collectionId,
    status: row.status as ExtractionStatus,
    requirement: row.requirement,
    categories: row.categories ?? [],
    sourceAssetIds: row.sourceAssetIds ?? [],
    progress: (row.progress as ExtractionProgress | null) ?? null,
    error: (row.error as ExtractionErrorRecord | null) ?? null,
    extraPrompt: row.extraPrompt,
    currentItemKey: row.currentItemKey,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

/** 可空的 jsonb 列：`null` 写 SQL NULL，其余按 JSON 写入。 */
function jsonOrDbNull(value: object | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue);
}

const LIBRARY_SELECT = {
  id: true,
  collectionId: true,
  extractionRunId: true,
  sourceAssetId: true,
  category: true,
  storageKey: true,
  fileName: true,
  mimeType: true,
  width: true,
  height: true,
  sortOrder: true,
  watermarkRemoved: true,
  watermarkNote: true,
  createdAt: true,
} as const;

const ITEM_SELECT = {
  id: true,
  extractionRunId: true,
  sourceAssetId: true,
  category: true,
  status: true,
  libraryAssetId: true,
  skipReason: true,
  error: true,
  createdAt: true,
} as const;

interface RawItemRow {
  id: string;
  extractionRunId: string;
  sourceAssetId: string;
  category: string;
  status: string;
  libraryAssetId: string | null;
  skipReason: string | null;
  error: unknown;
  createdAt: Date;
}

function toItemRecord(row: RawItemRow): ExtractionItemRecord {
  return {
    id: row.id,
    extractionRunId: row.extractionRunId,
    sourceAssetId: row.sourceAssetId,
    category: row.category,
    status: row.status as ExtractionItemRecord["status"],
    libraryAssetId: row.libraryAssetId,
    skipReason: row.skipReason,
    error: (row.error as ExtractionItemRecord["error"]) ?? null,
    createdAt: row.createdAt,
  };
}

export interface NewRunInput {
  collectionId: string;
  requirement: string;
  categories: string[];
  sourceAssetIds: string[];
  extraPrompt: string | null;
  progress: ExtractionProgress;
}

/**
 * 创建运行：状态直接是 queued，进度里的 `total` 在创建时就算好 ——
 * 接口层要立刻给得出「原图数 × 类别数」（AC-LIB-1），不靠执行时补写。
 */
export async function createRun(input: NewRunInput): Promise<ExtractionRunRecord> {
  const row = await getDb().extractionRun.create({
    data: {
      id: randomUUID(),
      collectionId: input.collectionId,
      status: "queued",
      requirement: input.requirement,
      categories: input.categories,
      sourceAssetIds: input.sourceAssetIds,
      extraPrompt: input.extraPrompt,
      progress: input.progress as unknown as Prisma.InputJsonValue,
    },
    select: RUN_SELECT,
  });
  return toRunRecord(row as RawRunRow);
}

/** 按创建时间倒序；同一时间按 id 兜底，翻页与展示稳定。 */
export async function listRunsByCollection(collectionId: string): Promise<ExtractionRunRecord[]> {
  const rows = await getDb().extractionRun.findMany({
    where: { collectionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: RUN_SELECT,
  });
  return (rows as RawRunRow[]).map(toRunRecord);
}

/** 出队：最早的 queued 运行；条件更新即认领，并发时只有一条能把 queued 改成 running。 */
export async function claimNextRun(now: Date): Promise<ExtractionRunRecord | null> {
  void now;
  const db = getDb();
  const candidate = await db.extractionRun.findFirst({
    where: { status: "queued" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: RUN_SELECT,
  });
  if (!candidate) return null;

  const { count } = await db.extractionRun.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: { status: "running" },
  });
  if (count === 0) return null;

  return toRunRecord({ ...candidate, status: "running", finishedAt: null } as RawRunRow);
}

/**
 * 进度与「正在处理的那一格」只写 running 的行：终态会清空它们，迟到的写入不该复活它。
 * 两件事同一笔写入，界面看到的就是「第 k 项做完、第 k+1 项在跑」（MKACG-999）。
 */
export async function updateRunProgress(
  runId: string,
  progress: ExtractionProgress,
  currentItemKey: string | null,
): Promise<number> {
  const { count } = await getDb().extractionRun.updateMany({
    where: { id: runId, status: "running" },
    data: { progress: progress as unknown as Prisma.InputJsonValue, currentItemKey },
  });
  return count;
}

/** 写终态并清空进度；只认 running，返回受影响行数。 */
export async function finishRun(
  runId: string,
  status: ExtractionStatus,
  error: ExtractionErrorRecord | null,
  now: Date,
): Promise<number> {
  const { count } = await getDb().extractionRun.updateMany({
    where: { id: runId, status: "running" },
    data: {
      status,
      finishedAt: now,
      error: jsonOrDbNull(error),
      progress: Prisma.DbNull,
      currentItemKey: null,
    },
  });
  return count;
}

/** 服务启动时清理残留状态：running → failed，queued 保持待跑。 */
export async function failRunningRuns(
  error: ExtractionErrorRecord,
  now: Date,
): Promise<number> {
  const { count } = await getDb().extractionRun.updateMany({
    where: { status: "running" },
    data: {
      status: "failed",
      finishedAt: now,
      error: jsonOrDbNull(error),
      progress: Prisma.DbNull,
      currentItemKey: null,
    },
  });
  return count;
}

/**
 * 成功的产出入库：同一批一次写入，素材与运行分开两笔（素材先到，终态后写）。
 * 返回落库后的记录 —— 提取条目要用它拿到 `library_asset_id`（ADR 0011 第 3 条）。
 */
export async function saveAssets(
  runId: string,
  collectionId: string,
  assets: readonly LibraryAssetInput[],
): Promise<LibraryAssetRecord[]> {
  if (assets.length === 0) return [];
  const rows = await getDb().libraryAsset.createManyAndReturn({
    data: assets.map((asset) => ({
      id: randomUUID(),
      collectionId,
      extractionRunId: runId,
      sourceAssetId: asset.sourceAssetId,
      category: asset.category,
      storageKey: asset.storageKey,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      sortOrder: asset.sortOrder,
      watermarkRemoved: asset.watermarkRemoved,
      watermarkNote: asset.watermarkNote,
    })),
    select: LIBRARY_SELECT,
  });
  return rows as LibraryAssetRecord[];
}

/** 写这一批提取条目：三种结局各一条，一次写入（ADR 0011 第 3 条）。 */
export async function saveItems(
  runId: string,
  items: readonly ExtractionItemInput[],
): Promise<void> {
  if (items.length === 0) return;
  await getDb().extractionItem.createMany({
    data: items.map((item) => ({
      id: randomUUID(),
      extractionRunId: runId,
      sourceAssetId: item.sourceAssetId,
      category: item.category,
      status: item.status,
      libraryAssetId: item.libraryAssetId,
      skipReason: item.skipReason,
      error: jsonOrDbNull(item.error),
    })),
  });
}

/**
 * 素材库里「判定为不存在」的条目（AC-LIB-11）：界面在对应组内显示「判定为不存在」与模型原话。
 * 组内按生成时间倒序，与素材同一顺序。
 */
export async function listSkippedItemsByCollection(
  collectionId: string,
): Promise<ExtractionItemRecord[]> {
  const rows = await getDb().extractionItem.findMany({
    where: { status: "skipped", extractionRun: { collectionId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: ITEM_SELECT,
  });
  return (rows as RawItemRow[]).map(toItemRecord);
}

/** 素材库：组内按生成时间倒序（docs/prd/12 SHOULD）。 */
export async function listLibraryByCollection(collectionId: string): Promise<LibraryAssetRecord[]> {
  return getDb().libraryAsset.findMany({
    where: { collectionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIBRARY_SELECT,
  });
}

export async function findLibraryAsset(assetId: string): Promise<LibraryAssetRecord | null> {
  return getDb().libraryAsset.findUnique({ where: { id: assetId }, select: LIBRARY_SELECT });
}

/** 删除一张素材；返回被删的 storage_key 与运行 id，供调用方清理磁盘。 */
export async function deleteLibraryAsset(
  assetId: string,
): Promise<{ storageKey: string; runId: string } | null> {
  const row = await getDb().libraryAsset.findUnique({
    where: { id: assetId },
    select: { storageKey: true, extractionRunId: true },
  });
  if (!row) return null;
  const { count } = await getDb().libraryAsset.deleteMany({ where: { id: assetId } });
  return count > 0 ? { storageKey: row.storageKey, runId: row.extractionRunId } : null;
}

/** 资源夹侧要的计数（「有运行中提取」判定与列表的派生状态）。 */
export interface ExtractionUsage {
  /** 排队或执行中的提取数：此时改图或删夹会影响正在进行的提取。 */
  activeRuns: number;
  runs: number;
  /** 素材库里的素材数。 */
  libraryAssets: number;
}

export async function countCollectionUsage(collectionId: string): Promise<ExtractionUsage> {
  const db = getDb();
  const [activeRuns, runs, libraryAssets] = await Promise.all([
    db.extractionRun.count({
      where: { collectionId, status: { in: ["queued", "running"] } },
    }),
    db.extractionRun.count({ where: { collectionId } }),
    db.libraryAsset.count({ where: { collectionId } }),
  ]);
  return { activeRuns, runs, libraryAssets };
}

/** 工作台「待创作」：还没有任何素材的资源夹数（docs/prd/09 MUST 1）。 */
export async function countCollectionsWithoutLibrary(): Promise<number> {
  return getDb().mediaCollection.count({ where: { libraryAssets: { none: {} } } });
}

export const extractionStore: ExtractionStore = {
  claimNextRun,
  updateRunProgress,
  finishRun,
  failRunningRuns,
  saveAssets,
  saveItems,
};
