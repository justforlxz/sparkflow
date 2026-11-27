-- 原图四角框选 + 单应透视矫正（MKACG-1001、docs/prd/13-quad-rectify.md）。
--
-- 只加列、不删列、不改类型、不回填（AGENTS.md 硬性规则 3）：
-- - `media_asset.quad`（jsonb，可空）：归一化四点 `[[x,y]×4]`，顺序「左上、右上、右下、左下」。
-- - `media_asset.quad_kind`（可空）：`surface`（桌面/桌垫四角）或 `pattern`（图案四角）。
-- - `media_asset.quad_real_width` / `quad_real_height`（可空）：用户手输的实际尺寸（毫米）。
-- - `media_asset.rectified_key`（可空）：矫正图的 storage_key；矫正失败时留空，四角仍然保留。
-- - `library_asset.source`（非空、默认 'model'）：产物来源。老素材全是模型产物，
--   默认值就是它们的真实来源；几何矫正的产物由代码显式写 'rectified'。
--
-- 全部可空列都不回填：老照片没有框选，行为与之前完全一致（AC-QUAD-7）。
ALTER TABLE "media_asset" ADD COLUMN "quad" JSONB;
ALTER TABLE "media_asset" ADD COLUMN "quad_kind" TEXT;
ALTER TABLE "media_asset" ADD COLUMN "quad_real_width" INTEGER;
ALTER TABLE "media_asset" ADD COLUMN "quad_real_height" INTEGER;
ALTER TABLE "media_asset" ADD COLUMN "rectified_key" TEXT;
ALTER TABLE "library_asset" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'model';
