/**
 * 磁盘存储目录。`UPLOAD_DIR` 下按 `media-assets/`（原图）与 `library-assets/`（素材图）分目录，
 * 具体子目录与文件名由各业务模块生成；这里负责根目录定位、路径段校验与 storage_key 解析。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "./env";
import { AppError } from "./errors";

export function storageRoot(): string {
  return path.resolve(getEnv().UPLOAD_DIR);
}

export async function ensureStorageRoot(): Promise<string> {
  const root = storageRoot();
  await mkdir(root, { recursive: true });
  return root;
}

/** storage_key 里的一段（资源夹 id、运行 id、文件名）只允许字母、数字与连字符。 */
const SAFE_SEGMENT = /^[A-Za-z0-9-]+$/;

export function assertStorageSegment(segment: string, message: string): void {
  if (!SAFE_SEGMENT.test(segment)) throw AppError.validationFailed(message);
}

/**
 * 把 storage_key 解析成磁盘绝对路径。`..`、绝对路径等越界写法一律拒绝，
 * 保证读取接口不会读到 `UPLOAD_DIR` 之外的文件。
 */
export function resolveStoragePath(storageKey: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw AppError.validationFailed("图片路径不合法");
  }
  return resolved;
}
