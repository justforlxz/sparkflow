/**
 * 磁盘存储目录。`UPLOAD_DIR` 下按 `media-assets/`（原图）与 `generated-assets/`（生成图）分目录，
 * 具体子目录与文件名由各业务模块生成；这里只负责根目录的定位与初始化。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "./env";

export function storageRoot(): string {
  return path.resolve(getEnv().UPLOAD_DIR);
}

export async function ensureStorageRoot(): Promise<string> {
  const root = storageRoot();
  await mkdir(root, { recursive: true });
  return root;
}
