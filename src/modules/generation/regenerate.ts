/**
 * 「重新生成」的纯逻辑（docs/prd/07 MUST 3、AC-04-9）。
 *
 * 重新生成按任务存下来的参数新建任务。ADR 0009 之前的旧任务存的是已经删除的视觉方向 key
 * （`fresh` / `editorial` / `product`），新登记表不接受：原样回传只会拿到 `VALIDATION_FAILED`，
 * 而任务列表没有别的入口能改正它。所以这里给出可选的提取要求——认得就沿用，认不得就退回
 * 登记表第一项，由界面让用户重选；提取目标仍来自资源夹，缺失时服务端会点名。
 *
 * 放在独立模块里是为了能在单测里锁住这两条规则，不用起浏览器。
 */
import { EXTRACT_REQUIREMENTS, findExtractRequirement } from "@/modules/image-generation/styles";

/** 任务存的提取要求是否仍是登记表里的值（ADR 0009 之前的旧任务为 false）。 */
export function isKnownExtractRequirement(value: string): boolean {
  return findExtractRequirement(value) !== undefined;
}

/** 重新生成弹窗里默认选中的提取要求：认得就沿用，否则退回登记表第一项。 */
export function defaultRegenerateRequirement(value: string): string {
  return isKnownExtractRequirement(value) ? value : EXTRACT_REQUIREMENTS[0].value;
}
