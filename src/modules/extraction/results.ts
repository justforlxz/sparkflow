/**
 * 「处理结果」按原图分组（ADR 0012 第 2 条、MKACG-974 AC-UI-8）：
 * 一张原图一张卡，卡内并排三类产出。数据没有变（提取条目本来就带
 * `source_asset_id` 与 `category`），这里只是换了一种读法。
 *
 * 每一格（原图 × 类别）显示**最近一次尝试**的结果：
 *
 * - `done`：入库的素材（library asset），可以点开看大图；
 * - `absent`：视觉判定为不存在（skipped），显示模型原话；
 * - `failed`：判定存在但生图失败，显示可读原因并能单独重试这一格；
 * - `pending`：有未终态的运行正在处理这一格（首次提取与单格重试都是这个状态）；
 * - `idle`：这一格还没有尝试过。
 *
 * 纯函数，单测在 `results.test.ts`。界面只消费结果，不自己判断状态与拼文案
 * （AGENTS.md 硬性规则 1）。
 */
import { SELECTABLE_CATEGORIES } from "./categories";
import type { ExtractionRunView, LibraryView } from "./view";

/** 卡片需要的原图信息：资源夹视图里的原图就满足这个形状，界面直接传进来。 */
export interface ResultSourceAsset {
  id: string;
  fileName: string;
  thumbnailUrl: string;
}

export interface ResultCellAsset {
  id: string;
  fileName: string;
  url: string;
  thumbnailUrl: string;
}

/**
 * 失败格的重试参数：只重跑这一格（这一张原图 × 这一个类别），
 * 提取要求沿用产出这次失败的那条运行（ADR 0005：重试只重跑失败的部分）。
 */
export interface ResultCellRetry {
  sourceAssetId: string;
  category: string;
  requirement: string;
}

export type ResultCellState = "idle" | "pending" | "done" | "absent" | "failed";

export interface ResultCellView {
  category: string;
  label: string;
  state: ResultCellState;
  /** `done` 时有值：可点开大图的产物。 */
  asset: ResultCellAsset | null;
  /** `absent` 时是模型原话，`failed` 时是失败原因；其余状态为 null。 */
  reason: string | null;
  /** `failed` 时有值；界面据此只重跑这一格。 */
  retry: ResultCellRetry | null;
}

export interface ResultCardView {
  sourceAssetId: string;
  fileName: string;
  thumbnailUrl: string;
  cells: ResultCellView[];
  /** 已完成的格数（卡片右上角 `2/3` 的分子）。 */
  done: number;
  /** 格数（等于三类产出的数量）。 */
  total: number;
  /**
   * 「重跑」这张原图的三类产出时沿用的提取要求：取最近一次包含这张原图的运行。
   * 还没跑过时为 null，界面退回右栏当前选中的要求。
   */
  requirement: string | null;
}

export interface ResultCardsInput {
  sourceAssets: readonly ResultSourceAsset[];
  library: LibraryView;
  runs: readonly ExtractionRunView[];
  /** 类别登记表；默认三类可选类别（`other` 只用于历史数据）。 */
  categories?: readonly { value: string; label: string }[];
}

interface Attempt {
  /** 尝试时间（毫秒），用来判断哪一次是「最近一次」。 */
  at: number;
  state: Exclude<ResultCellState, "idle" | "pending">;
  asset: ResultCellAsset | null;
  reason: string | null;
  retry: ResultCellRetry | null;
}

function cellKey(sourceAssetId: string, category: string): string {
  return `${sourceAssetId}\u0000${category}`;
}

/**
 * 一次尝试的时间点：素材与跳过条目用各自的 `createdAt`；失败项没有自己的时间，
 * 用整条运行的结束时间（失败是运行结束时统一记录的）。
 */
function runAttemptTime(run: ExtractionRunView): number {
  return Date.parse(run.finishedAt ?? run.createdAt);
}

/** 运行还没进终态时，它覆盖的每一格都在处理中（首次提取与单格重试都一样）。 */
function pendingKeys(runs: readonly ExtractionRunView[]): Set<string> {
  const keys = new Set<string>();
  for (const run of runs) {
    if (!isActive(run)) continue;
    for (const sourceAssetId of run.sourceAssetIds) {
      for (const category of run.categories) keys.add(cellKey(sourceAssetId, category));
    }
  }
  return keys;
}

function isActive(run: ExtractionRunView): boolean {
  return run.status === "queued" || run.status === "running";
}

/** 收集所有尝试，按 (原图, 类别) 取最近一次；同一时间点先出现的那条优先。 */
function collectAttempts(input: ResultCardsInput): Map<string, Attempt> {
  const attempts = new Map<string, Attempt>();

  function record(key: string, attempt: Attempt): void {
    const current = attempts.get(key);
    if (current && current.at > attempt.at) return;
    attempts.set(key, attempt);
  }

  for (const group of input.library.groups) {
    for (const asset of group.items) {
      record(cellKey(asset.sourceAssetId, asset.category), {
        at: Date.parse(asset.createdAt),
        state: "done",
        asset: {
          id: asset.id,
          fileName: asset.fileName,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
        },
        reason: null,
        retry: null,
      });
    }
    for (const item of group.skipped) {
      record(cellKey(item.sourceAssetId, item.category), {
        at: Date.parse(item.createdAt),
        state: "absent",
        asset: null,
        reason: item.reason,
        retry: null,
      });
    }
  }

  for (const run of input.runs) {
    for (const failure of run.error?.failures ?? []) {
      record(cellKey(failure.sourceAssetId, failure.category), {
        at: runAttemptTime(run),
        state: "failed",
        asset: null,
        reason: failure.message,
        retry: {
          sourceAssetId: failure.sourceAssetId,
          category: failure.category,
          requirement: run.requirement,
        },
      });
    }
  }

  return attempts;
}

/** 最近一次包含这张原图的运行用过的提取要求（没有运行过时为 null）。 */
function requirementOf(sourceAssetId: string, runs: readonly ExtractionRunView[]): string | null {
  for (const run of runs) {
    if (run.sourceAssetIds.includes(sourceAssetId)) return run.requirement;
  }
  return null;
}

/**
 * 按原图分组的结果卡片：原图顺序沿用资源夹里的顺序（`sortOrder`），
 * 每张卡固定三类产出，顺序取类别登记表（桌面俯视图 / 基本纹理 / 形象设计）。
 */
export function buildResultCards(input: ResultCardsInput): ResultCardView[] {
  const categories = input.categories ?? SELECTABLE_CATEGORIES;
  const attempts = collectAttempts(input);
  const pending = pendingKeys(input.runs);

  return input.sourceAssets.map((source) => {
    const cells = categories.map((category): ResultCellView => {
      const key = cellKey(source.id, category.value);
      const attempt = attempts.get(key);
      const base = { category: category.value, label: category.label };

      // 有运行正在处理这一格时，最新的一次尝试还没有结论：先显示「处理中」。
      if (pending.has(key)) {
        return { ...base, state: "pending", asset: null, reason: null, retry: null };
      }
      if (!attempt) {
        return { ...base, state: "idle", asset: null, reason: null, retry: null };
      }
      return {
        ...base,
        state: attempt.state,
        asset: attempt.asset,
        reason: attempt.reason,
        retry: attempt.retry,
      };
    });

    return {
      sourceAssetId: source.id,
      fileName: source.fileName,
      thumbnailUrl: source.thumbnailUrl,
      cells,
      done: cells.filter((cell) => cell.state === "done").length,
      total: cells.length,
      requirement: requirementOf(source.id, input.runs),
    };
  });
}
