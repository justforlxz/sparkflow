-- 文案与发布功能下线（ADR 0012 第 3 条、MKACG-976）。
--
-- 只删两张表和资源夹上的版本号计数器；照片、资源夹、提取运行、提取条目与素材库都不动
-- （AC-DEL-3：`media_asset`、`media_collection` 行数迁移前后不变）。
--
-- 历史数据不迁移：这两张表只有开发期测试数据（ADR 0012「后果」一节）。

-- 发布记录先删：它以 copy_version_id 外键指向文案版本。
DROP TABLE IF EXISTS "publish_record";

-- 文案版本。`copy_version_asset` 在历史迁移里从未建过，这里带上是为了「若存在也一并删掉」。
DROP TABLE IF EXISTS "copy_version_asset";
DROP TABLE IF EXISTS "copy_version";

-- 文案版本号计数器：只服务文案版本，随功能一并删除。
ALTER TABLE "media_collection" DROP COLUMN IF EXISTS "copy_version_seq";
