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
 * - `pending`：运行正在处理这一格（首次提取与单格重试都是这个状态）；
 * - `waiting`：同一次运行还没轮到这一格（MKACG-999）；
 * - `idle`：这一格还没有尝试过。
 *
 * 纯函数，单测在 `results.test.ts`。界面只消费结果，不自己判断状态与拼文案
 * （AGENTS.md 硬性规则 1）。
 */
import { SELECTABLE_CATEGORIES } from "./categories";
import { extractionItemKey } from "./item-key";
import type { ExtractionRunView, LibraryView } from "./view";

/** 卡片需要的原图信息：资源夹视图里的原图就满足这个形状，界面直接传进来。 */
export interface ResultSourceAsset {
  id: string;
  fileName: string;
  thumbnailUrl: string;
  /**
   * 这张原图已保存的框选用途（MKACG-1001）：null 表示未校正，卡片上要标「未校正」（AC-QUAD-7）。
   * 已校正时用它显示「已校正 · 桌面四角 / 图案四角」。
   */
  quadKind: string | null;
}

export interface ResultCellAsset {
  id: string;
  fileName: string;
  url: string;
  thumbnailUrl: string;
  /** 是否已经去掉上游水印（MKACG-1004）：false 时格子角上标「含水印」。 */
  watermarkRemoved: boolean;
  /** 没去水印的原因（可空），作为角标的提示文字。 */
  watermarkNote: string | null;
  /**
   * 产物来源（MKACG-1001）：`model` 是模型提取（可能重画），`rectified` 是几何矫正（原样）。
   * 界面上两者必须能看出来，不能让用户以为模型产物是原样（AC-QUAD-9、AC-QUAD-11）。
   */
  source: string;
  /** 来源的中文说明（来自模块常量，界面不自己拼）。 */
  sourceLabel: string;
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

/**
 * 一格的状态（MKACG-999）：
 * - `pending`：这一格正在被处理（运行指向它，`ExtractionRunView.currentItemKey`）；
 * - `waiting`：同一次运行还没轮到它；
 * - `idle`：没有任何运行覆盖过这一格。
 */
export type ResultCellState = "idle" | "pending" | "waiting" | "done" | "absent" | "failed";

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
  /** 已保存的框选用途；null 表示这张原图未校正（AC-QUAD-7）。界面据此显示角标。 */
  quadKind: string | null;
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
  state: Exclude<ResultCellState, "idle" | "pending" | "waiting">;
  asset: ResultCellAsset | null;
  reason: string | null;
  retry: ResultCellRetry | null;
}

/**
 * 一次尝试的时间点：素材与跳过条目用各自的 `createdAt`；失败项没有自己的时间，
 * 用整条运行的结束时间（失败是运行结束时统一记录的）。
 */
function runAttemptTime(run: ExtractionRunView): number {
  return Date.parse(run.finishedAt ?? run.createdAt);
}

/** 运行还没进终态时，它覆盖的每一格都还没出结论（首次提取与单格重试都一样）。 */
function pendingKeys(runs: readonly ExtractionRunView[]): Set<string> {
  const keys = new Set<string>();
  for (const run of runs) {
    if (!isActive(run)) continue;
    for (const sourceAssetId of run.sourceAssetIds) {
      for (const category of run.categories) {
        keys.add(extractionItemKey(sourceAssetId, category));
      }
    }
  }
  return keys;
}

function isActive(run: ExtractionRunView): boolean {
  return run.status === "queued" || run.status === "running";
}

/**
 * 正在处理的那一格：取第一条「在处理且已经指出当前条目」的活动运行。
 * 排队中（worker 还没认领）的运行没有这个值，它覆盖的格子都显示「等待中」（MKACG-999）。
 */
function currentItemKeyOf(runs: readonly ExtractionRunView[]): string | null {
  for (const run of runs) {
    if (isActive(run) && run.currentItemKey !== null) return run.currentItemKey;
  }
  return null;
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
      record(extractionItemKey(asset.sourceAssetId, asset.category), {
        at: Date.parse(asset.createdAt),
        state: "done",
        asset: {
          id: asset.id,
          fileName: asset.fileName,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
          watermarkRemoved: asset.watermarkRemoved,
          watermarkNote: asset.watermarkNote,
          source: asset.source,
          sourceLabel: asset.sourceLabel,
        },
        reason: null,
        retry: null,
      });
    }
    for (const item of group.skipped) {
      record(extractionItemKey(item.sourceAssetId, item.category), {
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
      record(extractionItemKey(failure.sourceAssetId, failure.category), {
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
  const current = currentItemKeyOf(input.runs);

  return input.sourceAssets.map((source) => {
    const cells = categories.map((category): ResultCellView => {
      const key = extractionItemKey(source.id, category.value);
      const attempt = attempts.get(key);
      const base = { category: category.value, label: category.label };

      // 运行还没给这一格结论：正在处理的那一格显示「处理中」，同运行其余格子显示「等待中」。
      if (pending.has(key)) {
        return {
          ...base,
          state: current === key ? "pending" : "waiting",
          asset: null,
          reason: null,
          retry: null,
        };
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
      quadKind: source.quadKind,
      cells,
      done: cells.filter((cell) => cell.state === "done").length,
      total: cells.length,
      requirement: requirementOf(source.id, input.runs),
    };
  });
}
