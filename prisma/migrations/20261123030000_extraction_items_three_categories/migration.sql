-- 提取改为三类目标 + 两段式判定（ADR 0011、docs/prd/05「内置类别」、docs/prd/12 MUST 2b/2c/2d）。
--
-- 三件事：
-- 1. 新增 `extraction_item`：一条 = 一次（原图 × 类别）的尝试，记 succeeded / skipped / failed。
--    `extraction_run.status` 的 `empty` 是字符串取值（列类型本来就是 TEXT），不需要改列。
-- 2. 类别枚举换成 topdown | texture | graphic | other：旧的 `material` / `border` 一律归到 `other`，
--    历史素材留在「其他（历史）」组里，数量不变（AC-LIB-15）。
-- 3. `extraction_run.categories` 里的旧 key 同样归到 `other`，否则运行列表会显示已经不存在的类别名。
--
-- 向前兼容：只加表、只改数据，不删列不改类型。旧代码在新库上仍能跑（它不认识 `extraction_item`，
-- 也不会写 `empty`），回滚只需要换回旧镜像。

-- CreateTable
CREATE TABLE "extraction_item" (
    "id" TEXT NOT NULL,
    "extraction_run_id" TEXT NOT NULL,
    "source_asset_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "library_asset_id" TEXT,
    "skip_reason" TEXT,
    "error" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extraction_item_extraction_run_id_idx" ON "extraction_item"("extraction_run_id");

-- CreateIndex
CREATE INDEX "extraction_item_extraction_run_id_status_idx" ON "extraction_item"("extraction_run_id", "status");

-- AddForeignKey
ALTER TABLE "extraction_item" ADD CONSTRAINT "extraction_item_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "extraction_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 历史素材的类别归到「其他（历史）」（AC-LIB-15）：只改旧的两个 key，已经是新 key 的行不受影响。
UPDATE "library_asset" SET "category" = 'other' WHERE "category" IN ('material', 'border');

-- 历史运行的类别清单同样归到 `other`，并去掉重复（material 与 border 会合并成一条）。
-- `ORDER BY 1` 让结果确定：没有它时同一份数据在不同环境可能给出不同顺序，历史运行行的展示会漂移。
UPDATE "extraction_run"
SET "categories" = ARRAY(
    SELECT DISTINCT CASE WHEN c IN ('material', 'border') THEN 'other' ELSE c END
    FROM unnest("categories") AS c
    ORDER BY 1
)
WHERE "categories" && ARRAY['material', 'border']::TEXT[];
