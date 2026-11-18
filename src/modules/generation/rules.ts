/** 创建任务前的规则校验（纯函数，抛 `AppError`）；Agent 就绪校验在 agent-config 模块。 */
import { AppError } from "@/lib/errors";

/**
 * 资源夹必须有至少一张原始图片（docs/prd/00-overview.md 全局规则 1）。
 * 正常情况下资源夹模块已经保证（建夹需图片、不允许删到 0 张），这里再挡一次，
 * 避免绕过接口改库后创建出没有素材的任务。
 */
export function assertCollectionHasImages(assetCount: number): void {
  if (assetCount < 1) {
    throw AppError.validationFailed("资源夹没有原始图片，不能创建创作任务");
  }
}
