-- 素材记录「是否已去掉上游水印」与原因（MKACG-1004，docs/prd/05「水印（实测结论）」）。
--
-- 只加两列，不删列、不改类型、不回填：
-- - `watermark_removed` 非空、默认 false —— 老素材确实都还带着上游水印，界面据此显示「含水印」
--   角标；新产物由代码显式写入真实结果（处理过为 true），不依赖这个默认值。
-- - `watermark_note` 可空 —— 只有没去水印时才写原因（主体贴底、后处理失败）。
ALTER TABLE "library_asset" ADD COLUMN "watermark_removed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "library_asset" ADD COLUMN "watermark_note" TEXT;
