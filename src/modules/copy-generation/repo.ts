/**
 * 文案版本的持久化访问（AGENTS.md 硬性规则 10：数据访问集中在这里）。
 * 版本号分配、状态流转的语义在 `service.ts` 与 `runner.ts`，这里只有查询与写入。
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import type { FailureRecord } from "@/lib/job-failure";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { CopyContent, CopyVersionRecord } from "./types";

const VERSION_SELECT = {
  id: true,
  collectionId: true,
  versionNo: true,
  status: true,
  title: true,
  body: true,
  tags: true,
  copyStyle: true,
  agentSnapshot: true,
  selectedAssetIds: true,
  extraPrompt: true,
  error: true,
  meta: true,
  createdAt: true,
  finishedAt: true,
} as const;

interface RawVersionRow {
  id: string;
  collectionId: string;
  versionNo: number;
  status: string;
  title: string | null;
  body: string | null;
  tags: string[];
  copyStyle: string;
  agentSnapshot: unknown;
  selectedAssetIds: string[];
  extraPrompt: string | null;
  error: unknown;
  meta: unknown;
  createdAt: Date;
  finishedAt: Date | null;
}

function toRecord(row: RawVersionRow): CopyVersionRecord {
  return {
    id: row.id,
    collectionId: row.collectionId,
    versionNo: row.versionNo,
    status: row.status as CopyVersionRecord["status"],
    title: row.title,
    body: row.body,
    tags: row.tags ?? [],
    copyStyle: row.copyStyle,
    agentSnapshot: row.agentSnapshot as AgentSnapshot,
    selectedAssetIds: row.selectedAssetIds ?? [],
    extraPrompt: row.extraPrompt,
    error: (row.error as FailureRecord | null) ?? null,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function jsonOrDbNull(value: object | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue);
}

export interface NewVersionInput {
  collectionId: string;
  /** 由资源夹分配的版本号（`media-collection` 的 `allocateCopyVersionNumber`）。 */
  versionNo: number;
  copyStyle: string;
  agentSnapshot: AgentSnapshot;
  selectedAssetIds: string[];
  extraPrompt: string | null;
}

/**
 * 创建版本。`version_no` 由资源夹的计数器分配（MUST 5：只增不减、不复用），
 * 本函数只负责写入；`(collection_id, version_no)` 的唯一约束是最后一道保险。
 */
export async function createVersion(input: NewVersionInput): Promise<CopyVersionRecord> {
  const row = await getDb().copyVersion.create({
    data: {
      id: randomUUID(),
      collectionId: input.collectionId,
      versionNo: input.versionNo,
      status: "queued",
      copyStyle: input.copyStyle,
      agentSnapshot: input.agentSnapshot as unknown as Prisma.InputJsonValue,
      selectedAssetIds: input.selectedAssetIds,
      extraPrompt: input.extraPrompt,
    },
    select: VERSION_SELECT,
  });
  return toRecord(row as RawVersionRow);
}

export async function findVersion(versionId: string): Promise<CopyVersionRecord | null> {
  const row = await getDb().copyVersion.findUnique({
    where: { id: versionId },
    select: VERSION_SELECT,
  });
  return row ? toRecord(row as RawVersionRow) : null;
}

/** 版本列表：最新在前（docs/prd/12「版本列表（倒序）」）。 */
export async function listVersionsByCollection(collectionId: string): Promise<CopyVersionRecord[]> {
  const rows = await getDb().copyVersion.findMany({
    where: { collectionId },
    orderBy: [{ versionNo: "desc" }],
    select: VERSION_SELECT,
  });
  return (rows as RawVersionRow[]).map(toRecord);
}

/** 出队：最早的 queued 版本；条件更新即认领，并发时只有一条能改成 running。 */
export async function claimNextVersion(now: Date): Promise<CopyVersionRecord | null> {
  void now;
  const db = getDb();
  const candidate = await db.copyVersion.findFirst({
    where: { status: "queued" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: VERSION_SELECT,
  });
  if (!candidate) return null;

  const { count } = await db.copyVersion.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: { status: "running" },
  });
  if (count === 0) return null;

  return toRecord({ ...candidate, status: "running" } as RawVersionRow);
}

/** 生成成功：写三段文案与终态；只认 running，返回受影响行数。 */
export async function markVersionSucceeded(
  versionId: string,
  copy: CopyContent,
  meta: Record<string, unknown> | null,
  now: Date,
): Promise<number> {
  const { count } = await getDb().copyVersion.updateMany({
    where: { id: versionId, status: "running" },
    data: {
      status: "succeeded",
      title: copy.title,
      body: copy.body,
      tags: copy.tags,
      error: Prisma.DbNull,
      meta: jsonOrDbNull(meta),
      finishedAt: now,
    },
  });
  return count;
}

/** 生成失败：写终态与可读原因；三段文案保持为空（不写脏数据）。 */
export async function markVersionFailed(
  versionId: string,
  error: FailureRecord,
  now: Date,
): Promise<number> {
  const { count } = await getDb().copyVersion.updateMany({
    where: { id: versionId, status: "running" },
    data: { status: "failed", error: jsonOrDbNull(error), finishedAt: now },
  });
  return count;
}

/** 服务启动时清理残留状态：running → failed，queued 保持待跑。 */
export async function failRunningVersions(error: FailureRecord, now: Date): Promise<number> {
  const { count } = await getDb().copyVersion.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: jsonOrDbNull(error), finishedAt: now },
  });
  return count;
}

export interface VersionFieldsPatch {
  title?: string;
  body?: string;
  tags?: string[];
}

/** 编辑当前版本：原地改该版本的三个字段，不产生新版本（docs/prd/12 MUST NOT）。 */
export async function updateVersionFields(
  versionId: string,
  patch: VersionFieldsPatch,
): Promise<boolean> {
  const { count } = await getDb().copyVersion.updateMany({
    where: { id: versionId },
    data: patch,
  });
  return count > 0;
}

/** 资源夹里的版本数（资源夹列表的派生状态用）。 */
export async function countCollectionVersions(collectionId: string): Promise<number> {
  return getDb().copyVersion.count({ where: { collectionId } });
}

/** 工作台「待发布」：还没有发布记录的版本数（docs/prd/09 MUST 1）。 */
export async function countUnpublishedVersions(): Promise<number> {
  return getDb().copyVersion.count({ where: { publishRecord: null } });
}

/** 工作台「最近生成的内容」的一行。 */
export interface RecentVersionRow {
  id: string;
  collectionId: string;
  versionNo: number;
  title: string | null;
  createdAt: Date;
  firstAssetId: string | null;
}

/** 最近生成的文案版本：按创建时间倒序取前 N 条，不加载全量（docs/prd/09 MUST 2）。 */
export async function listRecentVersions(limit: number): Promise<RecentVersionRow[]> {
  const rows = await getDb().copyVersion.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      collectionId: true,
      versionNo: true,
      title: true,
      createdAt: true,
      selectedAssetIds: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    collectionId: row.collectionId,
    versionNo: row.versionNo,
    title: row.title,
    createdAt: row.createdAt,
    firstAssetId: row.selectedAssetIds?.[0] ?? null,
  }));
}

/** 发布记录要显示版本号：只取 id 与版本号，不读整行。 */
export async function findVersionSummaries(
  versionIds: readonly string[],
): Promise<{ id: string; versionNo: number }[]> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return [];
  return getDb().copyVersion.findMany({
    where: { id: { in: unique } },
    select: { id: true, versionNo: true },
  });
}
