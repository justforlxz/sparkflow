/**
 * 业务状态到状态标签色板的唯一映射（docs/prd/09-dashboard.md SHOULD）。
 *
 * 颜色语义固定：待处理=蓝、生成中=强调色、待发布=橙、已发布=绿。
 * 页面与组件不自己挑色，也不写颜色字面值 —— 这里只给 `Pill` 的 tone 名，具体 class 在 `Pill.tsx`。
 */
import type { CopyVersionStatus } from "@/modules/copy-generation/constants";
import type { ExtractionStatus } from "@/modules/extraction/constants";
import type { CollectionStatus } from "@/modules/media-collection/constants";
import type { PillTone } from "./Pill";

/** 资源夹状态（`draft` / `generating` / `has_results` / `published`）。 */
export const COLLECTION_STATUS_TONE: Record<CollectionStatus, PillTone> = {
  draft: "draft",
  generating: "generating",
  has_results: "pendingPublish",
  published: "published",
};

/** 提取运行状态（`queued` / `running` / `succeeded` / `partial` / `failed`）。 */
export const EXTRACTION_STATUS_TONE: Record<ExtractionStatus, PillTone> = {
  queued: "neutral",
  running: "generating",
  succeeded: "published",
  partial: "pendingPublish",
  failed: "danger",
};

/** 文案版本状态（`queued` / `running` / `succeeded` / `failed`）。 */
export const COPY_VERSION_STATUS_TONE: Record<CopyVersionStatus, PillTone> = {
  queued: "neutral",
  running: "generating",
  succeeded: "published",
  failed: "danger",
};
