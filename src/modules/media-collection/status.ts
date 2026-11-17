/**
 * 资源夹状态是派生值，不落库（docs/prd/01-media-collection.md「数据与接口」）。
 * 判定顺序：有运行中任务 → `generating`；否则有发布记录 → `published`；
 * 否则有结果 → `has_results`；否则 `draft`。
 */
import { COLLECTION_STATUSES, type CollectionStatus } from "./constants";

export interface CollectionCounts {
  /** 运行中的创作任务数。 */
  runningTasks: number;
  /** 全部创作任务数。 */
  tasks: number;
  /** 创作结果数。 */
  results: number;
  /** 发布记录数。 */
  published: number;
}

export function deriveCollectionStatus(counts: CollectionCounts): CollectionStatus {
  if (counts.runningTasks > 0) return "generating";
  if (counts.published > 0) return "published";
  if (counts.results > 0) return "has_results";
  return "draft";
}

export function isCollectionStatus(value: string): value is CollectionStatus {
  return (COLLECTION_STATUSES as readonly string[]).includes(value);
}
