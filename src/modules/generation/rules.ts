/** 创建任务前的规则校验（纯函数，抛 `AppError`）；Agent 就绪校验在 agent-config 模块。 */
import { AppError } from "@/lib/errors";

/**
 * 「至少要有一张原图」只在发起创作时校验（docs/prd/00-overview.md 全局规则 1、
 * docs/prd/04-generation-task.md）。资源夹本身允许 0 张图片（docs/prd/01 MUST 1），
 * 所以这条判据属于任务创建路径，保存路径上没有对应规则（AC-01-2、AC-01-8）。
 */
export function assertCollectionHasImages(assetCount: number): void {
  if (assetCount < 1) {
    throw AppError.validationFailed("资源夹没有原始图片，不能创建创作任务");
  }
}
