/**
 * 业务状态到状态标签色板的唯一映射（docs/prd/09-dashboard.md SHOULD）。
 *
 * 颜色语义固定：待处理=蓝、生成中=强调色、有结果=橙、完成=绿。
 * 页面与组件不自己挑色，也不写颜色字面值 —— 这里只给 `Pill` 的 tone 名，具体 class 在 `Pill.tsx`。
 *
 * tone 名（`pendingPublish` / `published`）是设计变量里的颜色名，不是业务状态：
 * 资源夹状态已经没有「已发布」，但提取运行的「部分失败」仍借用橙色、「成功」仍借用绿色（MKACG-976）。
 */
import type { ExtractionStatus } from "@/modules/extraction/constants";
import type { CollectionStatus } from "@/modules/media-collection/constants";
import type { PillTone } from "./Pill";

/** 资源夹状态（`draft` / `generating` / `has_results`）。文案与发布下线后没有「已发布」。 */
export const COLLECTION_STATUS_TONE: Record<CollectionStatus, PillTone> = {
  draft: "draft",
  generating: "generating",
  has_results: "pendingPublish",
};

/** 提取运行状态（`queued` / `running` / `succeeded` / `partial` / `failed`）。 */
export const EXTRACTION_STATUS_TONE: Record<ExtractionStatus, PillTone> = {
  queued: "neutral",
  running: "generating",
  succeeded: "published",
  partial: "pendingPublish",
  failed: "danger",
  /** 「未发现可提取内容」不是失败：用中性色，不显示为错误（MUST 2c）。 */
  empty: "neutral",
};
