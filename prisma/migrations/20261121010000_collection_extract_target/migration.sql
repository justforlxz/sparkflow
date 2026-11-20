-- 资源夹新增「提取目标」（ADR 0009、docs/prd/01-media-collection.md）。
--
-- 可空：老资源夹没有这一项，保存路径不要求必填；发起创作时要求非空，
-- 判定落在任务创建路径上（AC-01-9），因此这里不给默认值、也不回填历史行。
ALTER TABLE "media_collection" ADD COLUMN "extract_target" TEXT;
