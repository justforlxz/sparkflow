/**
 * 资源夹的业务校验规则（纯函数，抛 `AppError`）。
 * 规则集中在这里，service 只负责编排；单测直接对着这些函数断言。
 */
import { AppError } from "@/lib/errors";

export const COLLECTION_ERROR_MESSAGES = {
  imageRequired: "资源夹至少需要 1 张原始图片",
  lastImage: "资源夹至少需要保留 1 张原始图片；如需清空图片，请直接删除资源夹",
  busy: "资源夹有运行中的任务，请等任务结束后再修改图片或删除",
  emptyFile: (fileName: string) => `「${fileName}」是空文件`,
  unsupportedType: (fileName: string) =>
    `「${fileName}」不是受支持的图片：只接受 JPEG、PNG、WebP，判定以文件内容为准`,
  tooLarge: (fileName: string, limit: string) => `「${fileName}」超过单张 ${limit} 的上限`,
  missingUpload: "有新增图片缺少文件内容，请重新选择图片",
  foreignAsset: "请求里有不属于这个资源夹的图片，请刷新页面后重试",
  duplicateAsset: "同一张图片在请求里出现了多次，请刷新页面后重试",
  unhandledAsset: "有图片没有给出保留或移除的处理方式，请刷新页面后重试",
  saveFailed: "保存失败，资源夹没有发生改动，请重试",
} as const;

/** 把字节数写成人能读的上限，供错误提示说明「具体上限」（AC-02-9）。 */
export function formatBytes(bytes: number): string {
  const mib = 1024 * 1024;
  if (bytes >= mib) {
    const value = bytes / mib;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
  }
  const kib = 1024;
  if (bytes >= kib) return `${Math.round(bytes / kib)} KiB`;
  return `${bytes} 字节`;
}

/** MUST 1：服务端校验「资源夹至少有 1 张原始图片」，不依赖前端拦截。 */
export function assertHasImage(imageCount: number): void {
  if (imageCount < 1) throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.imageRequired);
}

/** 解除关联不能让资源夹变成 0 张图片（MUST 1 在编辑路径上的表现）。 */
export function assertCanRemoveImage(remaining: number): void {
  if (remaining < 1) throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.lastImage);
}

/**
 * SHOULD：有运行中任务时拒绝改图与删除（AC-02-10 的判定点）。
 * `runningTasks` 由调用方从任务模块取，任务表在本节点尚未引入（见 service 的 `relatedCounts`）。
 */
export function assertCollectionMutable(runningTasks: number): void {
  if (runningTasks > 0) {
    throw new AppError("CONFLICT", COLLECTION_ERROR_MESSAGES.busy, {
      details: { code: "COLLECTION_BUSY", runningTasks },
    });
  }
}
