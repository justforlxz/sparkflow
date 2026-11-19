/**
 * 原图的磁盘读写。删除只发生在「整个资源夹被删除」时：
 * 解除单张图片的关联不删文件（MUST 4），历史结果引用的文件必须仍然可读。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { collectionStoragePrefix, resolveStoragePath } from "./storage-key";

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
 * 删除资源夹的图片目录。MUST 5：磁盘删除失败不得让请求失败，只记日志，
 * 避免留下「记录已删、文件还在」这种无法再清理的脏状态。
 */
export async function removeCollectionFiles(collectionId: string): Promise<void> {
  try {
    await rm(resolveStoragePath(collectionStoragePrefix(collectionId)), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    logger.error("删除资源夹图片目录失败，已跳过", { collectionId, error });
  }
}

/**
 * 整组保存失败时回滚本次新写的文件（补偿写入，只针对这一次请求自己写的文件）。
 * 与 MUST 5 同口径：删不掉只记日志，不让回滚本身再抛错。
 */
export async function removeAssetFile(storageKey: string): Promise<void> {
  try {
    await rm(resolveStoragePath(storageKey), { force: true });
  } catch (error) {
    logger.error("回滚新写入的图片文件失败，已跳过", { storageKey, error });
  }
}
