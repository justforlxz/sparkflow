/**
 * 原图的磁盘读写（ADR 0012 第 1 条）。
 *
 * 只有「从总资源库删除照片」才删文件：从资源夹里移除只删关联行（PRD 01 MUST 4），
 * 删除资源夹同样不删文件 —— 照片还留在池里，别的夹可能也在用。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { resolveStoragePath } from "./storage-key";

export async function writeAssetBytes(storageKey: string, bytes: Buffer): Promise<void> {
  const target = resolveStoragePath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function readAssetFile(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(resolveStoragePath(storageKey));
  } catch {
    throw AppError.notFound("图片文件不存在");
  }
}

/**
 * 删除单个原图文件。MUST 5 同口径：磁盘删除失败不得让请求失败，只记日志，
 * 避免留下「记录已删、文件还在」这种无法再清理的脏状态。
 * 整组保存失败时也用它回滚本次新写的文件（补偿写入，只针对这一次请求自己写的文件）。
 */
export async function removeAssetFile(storageKey: string): Promise<void> {
  try {
    await rm(resolveStoragePath(storageKey), { force: true });
  } catch (error) {
    logger.error("删除图片文件失败，已跳过", { storageKey, error });
  }
}
