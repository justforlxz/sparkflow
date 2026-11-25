-- 提取运行记录「当前正在处理的那一格」（MKACG-999，docs/prd/12-asset-library.md）。
--
-- 只加一个可空列：老运行没有这个值，界面按「还没轮到的格子」显示；不删列、不改类型、不回填历史行。
ALTER TABLE "extraction_run" ADD COLUMN "current_item_key" TEXT;
