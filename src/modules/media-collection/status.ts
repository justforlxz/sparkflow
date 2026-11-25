/**
 * 资源夹状态是派生值，不落库（docs/prd/01-media-collection.md「数据与接口」）。
 * 判定顺序：有排队/执行中的提取 → `generating`；否则有素材 → `has_results`；否则 `draft`。
 *
 * 文案与发布下线后不再有「已发布」状态（ADR 0012 第 3 条、MKACG-976）。
 */
import { COLLECTION_STATUSES, type CollectionStatus } from "./constants";

export interface CollectionCounts {
  /** 排队或执行中的提取运行数。 */
  runningExtractions: number;
  /** 全部提取运行数。 */
  extractionRuns: number;
  /** 素材库里的素材数。 */
  libraryAssets: number;
}

export function deriveCollectionStatus(counts: CollectionCounts): CollectionStatus {
  if (counts.runningExtractions > 0) return "generating";
  if (counts.libraryAssets > 0) return "has_results";
  return "draft";
}

export function isCollectionStatus(value: string): value is CollectionStatus {
  return (COLLECTION_STATUSES as readonly string[]).includes(value);
}
