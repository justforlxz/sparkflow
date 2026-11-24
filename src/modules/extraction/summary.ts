/**
 * 提取运行在界面上的派生读法：哪些运行要轮询、进度怎么念、失败几项。
 *
 * 纯函数，单测在 `summary.test.ts`。界面只消费结果，不自己判断状态与拼文案
 * （AGENTS.md 硬性规则 1）。
 */
import { EXTRACTION_ACTIVE_STATUSES, LIBRARY_COPY } from "./constants";
import type { ExtractionRunView } from "./view";

/** 还没进终态：界面据此决定是否轮询（docs/prd/07 MUST 4）。 */
export function isActiveRun(run: Pick<ExtractionRunView, "status">): boolean {
  return (EXTRACTION_ACTIVE_STATUSES as readonly string[]).includes(run.status);
}


/**
 * 进度条用的百分比：`done / total` 四舍五入到整数，夹在 0~100。
 * 没有进度（终态）或总数为 0 时给 0，界面据此不画进度条。
 */
export function progressPercent(progress: { done: number; total: number } | null): number {
  if (!progress || progress.total <= 0) return 0;
  const percent = Math.round((progress.done / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
}

/** 失败项数量：`error.failures` 为空（或没有 error）时为 0。 */
export function runFailureCount(run: Pick<ExtractionRunView, "error">): number {
  return run.error?.failures.length ?? 0;
}

/** 失败项数量文案：「失败项 1 条」；没有逐项失败时返回 null。 */
export function runFailureText(run: Pick<ExtractionRunView, "error">): string | null {
  const count = runFailureCount(run);
  if (count === 0) return null;
  return `${LIBRARY_COPY.failureCountLabel} ${count} ${LIBRARY_COPY.itemCountSuffix}`;
}
