-- 图生图一图对一图（ADR 0008）

-- 成品张数 = 原图张数：旧列保留历史数据，新任务不再写入，因此允许为空。
ALTER TABLE "generation_task" ALTER COLUMN "image_count" DROP NOT NULL;

-- 生图阶段的执行进度：{ done, total }，终态时清空。
ALTER TABLE "generation_stage" ADD COLUMN "progress" JSONB;

-- 成品对应的原图。
ALTER TABLE "generated_asset" ADD COLUMN "source_asset_id" TEXT;

-- CreateIndex
CREATE INDEX "generated_asset_source_asset_id_idx" ON "generated_asset"("source_asset_id");

-- AddForeignKey
ALTER TABLE "generated_asset" ADD CONSTRAINT "generated_asset_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
