-- 数据层重构：提取运行 / 素材库 / 文案版本 + 历史数据迁移（ADR 0010、docs/prd/12-asset-library.md）。
--
-- 一次性迁移，不留双模型：新表建好 → 历史数据搬过去 → 发布记录改挂文案版本 → 删旧表与
-- `media_collection.extract_target`。迁移不可逆（ADR 0010「风险」），部署前必须在真实库副本上演练。
--
-- 映射规则（ADR 0010 第 6 条）：
--   generation_result → copy_version（version_no 按资源夹内 created_at 顺序编 1..N；
--                                     selected_asset_ids 取该结果下生成图的 source_asset_id）
--   generated_asset   → library_asset（category = 'other'，保留来源原图）
--   generation_task   → extraction_run（status 按旧任务派生结果照搬，categories = ['other']，
--                                       source_asset_ids 取该任务结果的素材来源）
--   publish_record.result_id → copy_version_id（id 与 generation_result 一一对应，直接沿用）

-- CreateTable
CREATE TABLE "extraction_run" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requirement" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_asset_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "progress" JSONB,
    "error" JSONB,
    "extra_prompt" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "extraction_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_asset" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "extraction_run_id" TEXT NOT NULL,
    "source_asset_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copy_version" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "title" TEXT,
    "body" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "copy_style" TEXT NOT NULL,
    "agent_snapshot" JSONB NOT NULL,
    "selected_asset_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extra_prompt" TEXT,
    "error" JSONB,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "copy_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extraction_run_collection_id_created_at_idx" ON "extraction_run"("collection_id", "created_at");

-- CreateIndex
CREATE INDEX "extraction_run_status_idx" ON "extraction_run"("status");

-- CreateIndex
CREATE INDEX "library_asset_collection_id_category_created_at_idx" ON "library_asset"("collection_id", "category", "created_at");

-- CreateIndex
CREATE INDEX "library_asset_extraction_run_id_idx" ON "library_asset"("extraction_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "copy_version_collection_id_version_no_key" ON "copy_version"("collection_id", "version_no");

-- CreateIndex
CREATE INDEX "copy_version_collection_id_created_at_idx" ON "copy_version"("collection_id", "created_at");

-- CreateIndex
CREATE INDEX "copy_version_status_idx" ON "copy_version"("status");

-- AddForeignKey
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_asset" ADD CONSTRAINT "library_asset_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_asset" ADD CONSTRAINT "library_asset_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "extraction_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_version" ADD CONSTRAINT "copy_version_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 历史数据 → 提取运行。状态按旧模型「两条阶段派生任务状态」的判定表换成新枚举；
-- 还在排队/执行中的旧任务不会有人再推进，迁成 failed 并写明原因。
WITH legacy_status AS (
    SELECT
        t."id" AS task_id,
        CASE
            WHEN EXISTS (
                SELECT 1 FROM "generation_stage" s
                WHERE s."task_id" = t."id" AND s."status" IN ('queued', 'running')
            ) THEN 'failed'
            WHEN EXISTS (
                SELECT 1 FROM "generation_stage" s
                WHERE s."task_id" = t."id" AND s."stage" = 'image' AND s."status" = 'failed'
            ) THEN 'failed'
            WHEN EXISTS (
                SELECT 1 FROM "generation_stage" s
                WHERE s."task_id" = t."id" AND s."stage" = 'copy' AND s."status" = 'failed'
            ) THEN 'partial'
            WHEN EXISTS (
                SELECT 1 FROM "generation_stage" s
                WHERE s."task_id" = t."id" AND s."stage" = 'image'
                  AND s."status" = 'succeeded' AND s."error" IS NOT NULL
            ) THEN 'partial'
            WHEN EXISTS (
                SELECT 1 FROM "generation_stage" s
                WHERE s."task_id" = t."id" AND s."stage" = 'copy' AND s."status" = 'succeeded'
            ) THEN 'succeeded'
            ELSE 'failed'
        END AS status,
        COALESCE(
            (SELECT max(s."finished_at") FROM "generation_stage" s WHERE s."task_id" = t."id"),
            t."created_at"
        ) AS finished_at
    FROM "generation_task" t
), legacy_sources AS (
    SELECT r."task_id", array_agg(DISTINCT g."source_asset_id") AS ids
    FROM "generation_result" r
    JOIN "generated_asset" g ON g."result_id" = r."id"
    WHERE g."source_asset_id" IS NOT NULL
    GROUP BY r."task_id"
)
INSERT INTO "extraction_run" (
    "id", "collection_id", "status", "requirement", "categories", "source_asset_ids",
    "progress", "error", "extra_prompt", "created_at", "finished_at"
)
SELECT
    t."id",
    t."collection_id",
    ls."status",
    t."visual_style",
    ARRAY['other']::TEXT[],
    COALESCE(lso."ids", ARRAY[]::TEXT[]),
    NULL,
    CASE
        WHEN ls."status" = 'failed' THEN jsonb_build_object(
            'code', 'LEGACY_MIGRATED',
            'message', '这条提取运行由历史创作任务迁移而来，原失败原因没有保留',
            'at', to_char(t."created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ELSE NULL
    END,
    t."extra_prompt",
    t."created_at",
    ls."finished_at"
FROM "generation_task" t
JOIN legacy_status ls ON ls."task_id" = t."id"
LEFT JOIN legacy_sources lso ON lso."task_id" = t."id";

-- 历史生成图 → 素材库（类别 other，界面归到「其他（历史）」）。
-- `source_asset_id` 旧列可空（原图被解除关联时置空）：新表要求非空（MUST 3），
-- 先退回该资源夹的第一张原图，连原图都没剩下时退回这张生成图自己的 id（界面按「已解除关联」展示）。
INSERT INTO "library_asset" (
    "id", "collection_id", "extraction_run_id", "source_asset_id", "category",
    "storage_key", "file_name", "mime_type", "width", "height", "sort_order", "created_at"
)
SELECT
    g."id",
    r."collection_id",
    r."task_id",
    COALESCE(
        g."source_asset_id",
        (SELECT a."id" FROM "media_asset" a
         WHERE a."collection_id" = r."collection_id"
         ORDER BY a."sort_order" ASC, a."created_at" ASC LIMIT 1),
        g."id"
    ),
    'other',
    g."storage_key",
    g."file_name",
    g."mime_type",
    g."width",
    g."height",
    g."sort_order",
    r."created_at"
FROM "generated_asset" g
JOIN "generation_result" r ON r."id" = g."result_id";

-- 历史创作结果 → 文案版本（version_no 按资源夹内 created_at 顺序编 1..N）。
-- 旧模型里「文案阶段没成功」的结果存在（title / body 都为空，界面当时标为「文案未生成」）；
-- 迁成 status = 'failed' 并写明原因，避免它们被当成「已完成」的空版本被标记发布。
INSERT INTO "copy_version" (
    "id", "collection_id", "version_no", "status", "title", "body", "tags",
    "copy_style", "agent_snapshot", "selected_asset_ids", "extra_prompt", "error",
    "created_at", "finished_at"
)
SELECT
    r."id",
    r."collection_id",
    (ROW_NUMBER() OVER (PARTITION BY r."collection_id" ORDER BY r."created_at" ASC, r."id" ASC))::INTEGER,
    CASE WHEN r."title" IS NULL AND r."body" IS NULL THEN 'failed' ELSE 'succeeded' END,
    r."title",
    r."body",
    r."tags",
    COALESCE(t."copy_style", 'story'),
    COALESCE(t."agent_snapshot", '{}'::JSONB),
    COALESCE((
        SELECT array_agg(g."source_asset_id")
        FROM "generated_asset" g
        WHERE g."result_id" = r."id" AND g."source_asset_id" IS NOT NULL
    ), ARRAY[]::TEXT[]),
    t."extra_prompt",
    CASE
        WHEN r."title" IS NULL AND r."body" IS NULL THEN jsonb_build_object(
            'code', 'LEGACY_COPY_MISSING',
            'message', '历史结果没有生成出文案，迁移为失败版本',
            'at', to_char(r."created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ELSE NULL
    END,
    r."created_at",
    r."created_at"
FROM "generation_result" r
LEFT JOIN "generation_task" t ON t."id" = r."task_id";

-- 发布记录改挂文案版本：旧 result_id 与新 copy_version_id 一一对应（上面沿用了同一条 id）。
ALTER TABLE "publish_record" ADD COLUMN "copy_version_id" TEXT;
UPDATE "publish_record" SET "copy_version_id" = "result_id";
ALTER TABLE "publish_record" ALTER COLUMN "copy_version_id" SET NOT NULL;
DROP INDEX "publish_record_result_id_key";
ALTER TABLE "publish_record" DROP CONSTRAINT "publish_record_result_id_fkey";
ALTER TABLE "publish_record" DROP COLUMN "result_id";
CREATE UNIQUE INDEX "publish_record_copy_version_id_key" ON "publish_record"("copy_version_id");
ALTER TABLE "publish_record" ADD CONSTRAINT "publish_record_copy_version_id_fkey" FOREIGN KEY ("copy_version_id") REFERENCES "copy_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 旧表删除：先删子表（阶段、生成图），再删结果与任务。删除后不再保留任何旧模型查询路径。
DROP TABLE "generation_stage";
DROP TABLE "generated_asset";
DROP TABLE "generation_result";
DROP TABLE "generation_task";

-- 类别取代了单值提取目标（ADR 0010、MKACG-938 第 6 条）。
ALTER TABLE "media_collection" DROP COLUMN "extract_target";

-- 文案版本号的计数器（docs/prd/12 MUST 5）：只增不减，删掉版本后编号也不回收。
-- 历史版本已按 created_at 顺序编成 1..N，计数器从每个资源夹现有的最大版本号起步，
-- 保证迁移之后新生成的版本号接着往下走，不会和历史版本撞号。
ALTER TABLE "media_collection" ADD COLUMN "copy_version_seq" INTEGER NOT NULL DEFAULT 0;
UPDATE "media_collection" c
SET "copy_version_seq" = COALESCE(
    (SELECT max(v."version_no") FROM "copy_version" v WHERE v."collection_id" = c."id"),
    0
);
