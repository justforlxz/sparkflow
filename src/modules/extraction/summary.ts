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

/** 把运行拆成「进行中」与「已结束」两组，各自保持传入顺序。 */
export function splitRuns(runs: readonly ExtractionRunView[]): {
  active: ExtractionRunView[];
  finished: ExtractionRunView[];
} {
  const active: ExtractionRunView[] = [];
  const finished: ExtractionRunView[] = [];
  for (const run of runs) (isActiveRun(run) ? active : finished).push(run);
  return { active, finished };
}

/**
 * 进行中运行的进度文案：「正在提取 1/4」。
 * 终态运行时 `progress` 已被清空，返回 null，界面不显示这一行。
 */
export function runProgressText(run: Pick<ExtractionRunView, "progress">): string | null {
  if (!run.progress) return null;
  return `${LIBRARY_COPY.progressLabel} ${LIBRARY_COPY.progressFraction(run.progress)}`;
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
