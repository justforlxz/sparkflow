/** 创建任务前的规则校验（纯函数，抛 `AppError`）；Agent 就绪校验在 agent-config 模块。 */
import { AppError } from "@/lib/errors";
import { EXTRACT_REQUIREMENTS, findExtractRequirement } from "@/modules/image-generation/styles";

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

/**
 * 「提取目标」在发起创作时必须非空（docs/prd/01 AC-01-9、ADR 0009）：
 * 资源夹可以没有它（保存路径不拦），但提取阶段靠它决定取什么，所以任务创建路径要拦。
 * 报错里点名缺的是哪一项，用户知道该去编辑资源夹；返回值是去掉首尾空白后的原文，供快照固化。
 */
export function requireCollectionExtractTarget(extractTarget: string | null): string {
  const trimmed = extractTarget?.trim();
  if (!trimmed) {
    throw AppError.validationFailed("资源夹没有提取目标，请先在资源夹里填写「提取目标」再发起创作");
  }
  return trimmed;
}

/**
 * 提取要求的取值必须来自登记表（AC-EX-3）：旧的视觉方向三项已删除，再传进来就拒绝。
 * 可选值登记在 `image-generation/styles.ts`，这里不复制一份枚举。
 */
export function assertValidExtractRequirement(value: string): void {
  if (!findExtractRequirement(value)) {
    const allowed = EXTRACT_REQUIREMENTS.map((entry) => entry.label).join(" / ");
    throw AppError.validationFailed(`提取要求无效，请选择：${allowed}`);
  }
}
