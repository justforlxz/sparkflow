/**
 * 资源夹的业务校验规则（纯函数，抛 `AppError`）。
 * 规则集中在这里，service 只负责编排；单测直接对着这些函数断言。
 *
 * 这里**没有**「至少 1 张图片」这条规则：资源夹允许没有图片，用户常先建夹后收集素材
 * （docs/prd/01-media-collection.md MUST 1）。「至少要有一张原图」只在发起创作时校验，
 * 落在 `src/modules/generation/rules.ts`（AC-01-8）。
 */
import { AppError } from "@/lib/errors";

export const COLLECTION_ERROR_MESSAGES = {
  busy: "资源夹有运行中的提取，请等它结束后再修改图片或删除",
  emptyFile: (fileName: string) => `「${fileName}」是空文件`,
  unsupportedType: (fileName: string) =>
    `「${fileName}」不是受支持的图片：只接受 JPEG、PNG、WebP，判定以文件内容为准`,
  tooLarge: (fileName: string, limit: string) => `「${fileName}」超过单张 ${limit} 的上限`,
  missingUpload: "有新增图片缺少文件内容，请重新选择图片",
  foreignAsset: "请求里有不属于这个资源夹的图片，请刷新页面后重试",
  duplicateAsset: "同一张图片在请求里出现了多次，请刷新页面后重试",
  unhandledAsset: "有图片没有给出保留或移除的处理方式，请刷新页面后重试",
  saveFailed: "保存失败，资源夹没有发生改动，请重试",
  poolUploadFailed: "上传失败，总资源库没有新增照片，请重试",
  unknownPoolAsset: "有照片不在总资源库里，请刷新页面后重试",
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

/**
 * SHOULD：有运行中的提取时拒绝改图与删除（AC-02-10 的判定点）。
 * `runningExtractions` 由调用方从提取模块取（见 service 的 `relatedCounts`）。
 */
export function assertCollectionMutable(runningExtractions: number): void {
  if (runningExtractions > 0) {
    throw new AppError("CONFLICT", COLLECTION_ERROR_MESSAGES.busy, {
      details: { code: "COLLECTION_BUSY", runningExtractions },
    });
  }
}
