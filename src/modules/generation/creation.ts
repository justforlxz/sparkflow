/**
 * 资源夹详情「创作」区的纯逻辑（docs/prd/07-results.md「资源夹详情的「创作」区」）。
 *
 * 这里只有可计算的部分：任务分组、原图对照标签、折叠状态的本地读写。
 * 渲染、轮询与请求都在 `src/app/(app)/collections/[id]/creation-panel.tsx`，
 * 因此这些规则能被单测逐条锁定，不用起浏览器。
 */
import type { StageView, TaskSummaryView } from "./view";
import { CREATION_SECTION_COPY, STAGE_NAMES, type StageName } from "./constants";

export interface CreationTaskGroups {
  /** 排队中或执行中的任务：创作区顶部内联显示两个阶段与进度（MUST 1）。 */
  running: TaskSummaryView[];
  /** 失败或部分完成的任务：就地显示可读原因，能重试的才给「重试」（MUST 4）。 */
  troubled: TaskSummaryView[];
}

/**
 * 任务分成「正在跑」与「有失败」两组；成功的任务不单独占一块，
 * 它的产出已经在下面的结果里（结果按资源夹倒序，含 `partial` 结果）。
 */
export function groupCreationTasks(tasks: readonly TaskSummaryView[]): CreationTaskGroups {
  return {
    running: tasks.filter((task) => task.status === "running"),
    troubled: tasks.filter((task) => task.status === "failed" || task.status === "partial"),
  };
}

/**
 * 失败阶段的阶段名与标签。只有这里非空才渲染「重试」：重试只重跑失败阶段（ADR 0005），
 * 全部成功或只有「部分原图失败」（阶段本身成功）时点重试只会拿到 CONFLICT。
 */
export function failedStages(task: TaskSummaryView): { name: StageName; label: string }[] {
  return STAGE_NAMES.filter((name) => task.stages[name].status === "failed").map((name) => ({
    name,
    label: task.stages[name].label,
  }));
}

/** 一个任务的阶段视图，按执行顺序（生图在前、文案在后）。 */
export function orderedStages(task: TaskSummaryView): StageView[] {
  return STAGE_NAMES.map((name) => task.stages[name]);
}

/**
 * 成品图对应的原图标签：「原图 3」按资源夹里原图的顺序编号。
 *
 * `sourceAssetId` 为空说明原图已被解除关联，`indexOf` 为 -1 说明原图已从资源夹移除：
 * 两种情况都如实说明，不猜编号（ADR 0008 的对照关系只在原图还在时成立）。
 */
export function originalAssetLabel(
  sourceAssetId: string | null,
  sourceAssetIds: readonly string[],
): string {
  const index = sourceAssetId === null ? -1 : sourceAssetIds.indexOf(sourceAssetId);
  return index === -1
    ? CREATION_SECTION_COPY.noSourceAssetLabel
    : `${CREATION_SECTION_COPY.sourceAssetLabelPrefix} ${index + 1}`;
}

/** 折叠状态存本地、不落库（MUST 5）：一个键存「已展开的结果 id」，结果 id 全局唯一。 */
export const CREATION_EXPANDED_STORAGE_KEY = "sparkflow.creation.expanded";

/** 本地值坏掉或不是数组时按「全部折叠」处理：默认折叠是 MUST 2 的起点。 */
export function parseExpandedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id !== "");
  } catch {
    return [];
  }
}

export function serializeExpandedIds(ids: readonly string[]): string {
  return JSON.stringify(ids);
}

export function toggleExpandedId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

/** 读取失败的唯一后果是「刷新后回到折叠」，不能因此让页面报错。 */
export function readExpandedIds(storage: Pick<Storage, "getItem">): string[] {
  try {
    return parseExpandedIds(storage.getItem(CREATION_EXPANDED_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** 本地存储不可用（隐私模式、配额满）时仍然允许展开/收起，只是刷新后不再保持。 */
export function writeExpandedIds(
  storage: Pick<Storage, "setItem">,
  ids: readonly string[],
): void {
  try {
    storage.setItem(CREATION_EXPANDED_STORAGE_KEY, serializeExpandedIds(ids));
  } catch {
    // 有意忽略：折叠状态是纯界面偏好，写不进去不影响功能。
  }
}
