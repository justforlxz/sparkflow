/**
 * 提取运行在界面上的派生读法：哪些运行要轮询、进度怎么念、失败几项。
 *
 * 纯函数，单测在 `summary.test.ts`。界面只消费结果，不自己判断状态与拼文案
 * （AGENTS.md 硬性规则 1）。
 */
import { EXTRACTION_ACTIVE_STATUSES, LIBRARY_COPY, type ExtractionOverviewState } from "./constants";
import type { ResultCellState } from "./results";
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

/** 页头状态只需要「格子的状态」这一个维度，不要求整张卡片视图。 */
export interface OverviewCard {
  cells: readonly { state: ResultCellState }[];
}

export interface ExtractionOverview {
  state: ExtractionOverviewState;
  /** 界面直接显示的中文标签。 */
  label: string;
  /** 已经有产物的格数（原图 × 类别）。 */
  done: number;
  /** 全部格数。 */
  total: number;
}

const OVERVIEW_LABELS: Record<ExtractionOverviewState, string> = {
  ready: LIBRARY_COPY.overviewReady,
  partial: LIBRARY_COPY.overviewPartial,
  failed: LIBRARY_COPY.overviewFailed,
  absent: LIBRARY_COPY.overviewAbsent,
  idle: LIBRARY_COPY.overviewIdle,
};

/**
 * 页头「提取状态」唯一口径（MKACG-1007 AC-UX-2）：由本夹**全部原图**的格子推导，
 * 抄最近一条运行的状态会把「只跑了一张图」读成「已完成」。
 *
 * 判定顺序（先命中先返回，保证同一种数据只有一个答案）：
 * 1. 每格都有产物 → `ready`「已提取」；
 * 2. 有任何失败格 → `failed`「有失败项」（要用户动手，优先于「部分完成」）；
 * 3. 有产物但没齐 → `partial`「部分完成」；
 * 4. 一格产物都没有、但每格都判定为不存在 → `absent`「未发现可提取内容」（AC-LIB-12，不是失败）；
 * 5. 其余（没跑过、跑着、还有格子没结论）→ `idle`「待提取」。
 */
export function extractionOverview(cards: readonly OverviewCard[]): ExtractionOverview {
  let done = 0;
  let failed = 0;
  let absent = 0;
  let total = 0;

  for (const card of cards) {
    for (const cell of card.cells) {
      total += 1;
      if (cell.state === "done") done += 1;
      else if (cell.state === "failed") failed += 1;
      else if (cell.state === "absent") absent += 1;
    }
  }

  const state: ExtractionOverviewState =
    total > 0 && done === total
      ? "ready"
      : failed > 0
        ? "failed"
        : done > 0
          ? "partial"
          : total > 0 && absent === total
            ? "absent"
            : "idle";

  return { state, label: OVERVIEW_LABELS[state], done, total };
}
