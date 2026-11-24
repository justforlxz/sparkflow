-- 照片池化第一版：建 `collection_asset` 并搬数据，**不删任何列**
-- （ADR 0012 第 1 条、docs/prd/01-media-collection.md「范围」、AGENTS.md 硬性规则 3）。
--
-- 这一支迁移只做「向前兼容」的那一半。`media_asset.collection_id` 与 `sort_order` 两列保留到下一版
-- `MKACG-981` 才删 —— 生产升级是换镜像重启（docs/development.md「部署」），回滚就是把镜像换回上一版，
-- 而库已经迁移过了；两列留着，上一版镜像才读得出照片。
--
-- 三条硬约束：
-- 1. **MUST NOT 删除任何 `media_asset` 行**：迁移前后行数必须相同（AC-POOL-1）。
-- 2. `collection_id` 改成可空：新代码写入的照片不再有归属。
-- 3. 外键必须从 `ON DELETE CASCADE` 改成 `ON DELETE SET NULL`：删资源夹时迁移来的历史照片
--    只是丢掉归属，行必须留下（AC-POOL-8）。用 `CASCADE` 会整批删掉它们。
--
-- 演练记录见 `docs/acceptance/records.md` 的「28 数据层：照片池化」行（合并前由 PL 追加）。

-- CreateTable
CREATE TABLE "collection_asset" (
    "collection_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_asset_pkey" PRIMARY KEY ("collection_id","asset_id")
);

-- CreateIndex
CREATE INDEX "collection_asset_collection_id_sort_order_idx" ON "collection_asset"("collection_id", "sort_order");

-- AddForeignKey
ALTER TABLE "collection_asset" ADD CONSTRAINT "collection_asset_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_asset" ADD CONSTRAINT "collection_asset_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 历史数据：一张照片一行关联，顺序与归属照搬旧列。
-- 关联行数 = 迁移前 `media_asset` 的行数（`collection_id` 是 NOT NULL，没有「无归属」的历史照片）。
INSERT INTO "collection_asset" ("collection_id", "asset_id", "sort_order", "added_at")
SELECT "collection_id", "id", "sort_order", "created_at" FROM "media_asset";

-- 新代码写入的照片没有归属资源夹。
ALTER TABLE "media_asset" ALTER COLUMN "collection_id" DROP NOT NULL;

-- 删资源夹时历史照片必须留下（AC-POOL-8）：改外键动作，不删行。
ALTER TABLE "media_asset" DROP CONSTRAINT "media_asset_collection_id_fkey";
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
