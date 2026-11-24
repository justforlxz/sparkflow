import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例（AC-POOL-1、ADR 0012「风险」）：照片池化只搬关联、不删照片。
 *
 * 做法：在独立 schema 里按名字顺序重放「本次迁移之前」的全部旧迁移 → 灌一份旧模型数据
 * （3 个资源夹、每个夹若干照片）→ 只执行本次迁移 → 回读断言。
 * 独立 schema 是为了不碰其它集成用例在 public 里的数据。
 *
 * 这条用例测的是 SQL 本身：只改 Prisma schema 不写迁移、或者迁移里写了 `DELETE FROM media_asset`，
 * 单测与类型检查都发现不了，只有回读行数能发现。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** 被测迁移：照片池化 + 关联表。之前的迁移都是旧模型（`media_asset.collection_id` 非空）。 */
const TARGET_MIGRATION = "20261124120000_collection_asset_pool";
const SCHEMA = "migration_pool_check";

/**
 * 旧模型里的 3 个资源夹，照片数各不同（含 0 张的夹）。
 * 数组顺序就是按 `sort_order` 升序后应有的**期望顺序** —— `pool-a` 故意与 id 顺序相反，
 * 迁移若把 `sort_order` 全写成默认值 0，这条用例就会失败。
 */
const COLLECTIONS = {
  "pool-a": ["pool-a-3", "pool-a-2", "pool-a-1"],
  "pool-b": ["pool-b-1"],
  "pool-empty": [] as string[],
} as const;

const TOTAL_ASSETS = Object.values(COLLECTIONS).reduce((sum, ids) => sum + ids.length, 0);

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * 旧模型数据：`media_asset` 带 `collection_id` 与 `sort_order`。
 * `pool-a` 的 `sort_order` 故意与 id 顺序相反（3 号排第一），这样「顺序也搬过来了」才是被验证的事实。
 */
const LEGACY_SEED = `
INSERT INTO "media_collection" ("id", "name", "updated_at") VALUES
    ('pool-a', '迁移用例-夹 A', now()),
    ('pool-b', '迁移用例-夹 B', now()),
    ('pool-empty', '迁移用例-空夹', now());

INSERT INTO "media_asset" ("id", "collection_id", "storage_key", "file_name", "mime_type", "size", "sort_order")
VALUES
    ('pool-a-1', 'pool-a', 'media-assets/pool-a/1.png', '1.png', 'image/png', 1, 2),
    ('pool-a-2', 'pool-a', 'media-assets/pool-a/2.png', '2.png', 'image/png', 2, 1),
    ('pool-a-3', 'pool-a', 'media-assets/pool-a/3.png', '3.png', 'image/png', 3, 0),
    ('pool-b-1', 'pool-b', 'media-assets/pool-b/1.png', '1.png', 'image/png', 1, 0);
`;

const client = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.query(`SET search_path TO "${SCHEMA}"`);

  const files = migrationFiles();
  const target = files.indexOf(TARGET_MIGRATION);
  expect(target).toBeGreaterThan(0);

  for (const name of files.slice(0, target)) {
    await client.query(readFileSync(path.join(MIGRATION_DIR, name, "migration.sql"), "utf8"));
  }
  await client.query(LEGACY_SEED);
  await client.query(readFileSync(path.join(MIGRATION_DIR, TARGET_MIGRATION, "migration.sql"), "utf8"));
  await client.query(`SET search_path TO "${SCHEMA}"`);
}, 60_000);

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe("迁移后的数据与表结构不变量（AC-POOL-1、AC-POOL-8）", () => {
  test("AC-POOL-1 media_asset 行数与迁移前一致", async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM "media_asset"`,
    );
    expect(Number(rows[0].count)).toBe(TOTAL_ASSETS);
  });

  test("AC-POOL-1 collection_asset 行数 = 迁移前 collection_id 非空的行数", async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM "collection_asset"`,
    );
    // 旧模型的 `collection_id` 是 NOT NULL，所以「非空行数」就是全部照片行数。
    expect(Number(rows[0].count)).toBe(TOTAL_ASSETS);
  });

  test("AC-POOL-1 抽查 3 个资源夹：照片 id 集合与迁移前相同，顺序照搬 sort_order", async () => {
    for (const [collectionId, expected] of Object.entries(COLLECTIONS)) {
      const { rows } = await client.query<{ asset_id: string }>(
        `SELECT "asset_id" FROM "collection_asset"
         WHERE "collection_id" = $1
         ORDER BY "sort_order", "asset_id"`,
        [collectionId],
      );
      // 与期望列表逐位比较，不排序：`sort_order` 被搬错（例如全写成 0）会让顺序对不上。
      expect(rows.map((row) => row.asset_id)).toEqual([...expected]);
    }
  });

  test("本版不删列：collection_id 改可空、sort_order 与索引仍在（删列留到 MKACG-981）", async () => {
    const columns = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'media_asset'
         AND column_name IN ('collection_id', 'sort_order')
       ORDER BY column_name`,
      [SCHEMA],
    );
    expect(columns.rows).toEqual([
      { column_name: "collection_id", is_nullable: "YES" },
      { column_name: "sort_order", is_nullable: "NO" },
    ]);

    // 索引留着：上一版镜像按它查 `collection_id` + `sort_order`。
    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'media_asset'
       ORDER BY indexname`,
      [SCHEMA],
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      "media_asset_collection_id_sort_order_idx",
    );
  });

  test("AC-POOL-8 归属外键是 ON DELETE SET NULL，不是 CASCADE", async () => {
    // confdeltype：'n' = SET NULL，'c' = CASCADE。用 CASCADE 会在删夹时整批删掉迁移来的照片。
    const { rows } = await client.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.conname = 'media_asset_collection_id_fkey'
         AND t.relname = 'media_asset' AND n.nspname = $1`,
      [SCHEMA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].confdeltype).toBe("n");
  });

  test("AC-POOL-1 / AC-POOL-8 关联行随资源夹级联删除，照片行留下且归属被清空", async () => {
    // 在事务里删夹再回滚：这条用例不改动其它断言依赖的数据。
    await client.query("BEGIN");
    try {
      await client.query(`DELETE FROM "media_collection" WHERE "id" = 'pool-a'`);
      const links = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM "collection_asset" WHERE "collection_id" = 'pool-a'`,
      );
      const assets = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM "media_asset"`,
      );
      // 旧外键是 CASCADE 时这里会是 0，正好是 AC-POOL-8 要挡住的失效。
      const orphaned = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM "media_asset"
         WHERE "id" IN ('pool-a-1', 'pool-a-2', 'pool-a-3') AND "collection_id" IS NULL`,
      );
      expect(Number(links.rows[0].count)).toBe(0);
      expect(Number(assets.rows[0].count)).toBe(TOTAL_ASSETS);
      expect(Number(orphaned.rows[0].count)).toBe(COLLECTIONS["pool-a"].length);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
