import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例：下线文案与发布（ADR 0012 第 3 条、MKACG-976 AC-DEL-3）。
 *
 * 做法与 `migration-asset-library.test.ts` 相同：在独立 schema 里按名字顺序重放「本次迁移之前」
 * 的全部迁移 → 灌一份旧模型数据 → 只执行本次迁移 → 回读断言。独立 schema 是为了不碰其它用例
 * 在 public 里的数据。
 *
 * 这条用例锁住的是「删表和删列不能碰照片与资源夹」：`pg_dump` 出来的库副本上人工验证过一次，
 * 但那不是自动化判据。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** 被测迁移：删 copy_version / publish_record 两张表与 copy_version_seq 列。 */
const TARGET_MIGRATION = "20261125090000_drop_copy_and_publish";
const SCHEMA = "migration_drop_check";

const COLLECTION_ID = "drop-collection";
const PUBLISHED_COLLECTION_ID = "drop-collection-published";
const VERSION_ID = "drop-version";
const RECORD_ID = "drop-publish";
const ASSET_IDS = ["drop-asset-1", "drop-asset-2", "drop-asset-3"];

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 两个资源夹、3 张照片、1 条文案版本、1 条发布记录。 */
const SEED = `
INSERT INTO "media_collection" ("id", "name", "updated_at") VALUES
    ('${COLLECTION_ID}', '下线用例-有版本', now()),
    ('${PUBLISHED_COLLECTION_ID}', '下线用例-已发布', now());

INSERT INTO "media_asset" ("id", "collection_id", "storage_key", "file_name", "mime_type", "size", "sort_order")
VALUES
    ('${ASSET_IDS[0]}', '${COLLECTION_ID}', 'media-assets/drop-1.png', 'drop-1.png', 'image/png', 1, 0),
    ('${ASSET_IDS[1]}', '${COLLECTION_ID}', 'media-assets/drop-2.png', 'drop-2.png', 'image/png', 1, 1),
    ('${ASSET_IDS[2]}', '${PUBLISHED_COLLECTION_ID}', 'media-assets/drop-3.png', 'drop-3.png', 'image/png', 1, 0);

INSERT INTO "copy_version"
    ("id", "collection_id", "version_no", "status", "title", "body", "copy_style", "agent_snapshot", "selected_asset_ids")
VALUES
    ('${VERSION_ID}', '${PUBLISHED_COLLECTION_ID}', 1, 'succeeded', '标题', '正文', 'story', '{}'::JSONB, ARRAY['${ASSET_IDS[2]}']);

INSERT INTO "publish_record"
    ("id", "copy_version_id", "collection_id", "platform", "published_at", "title_snapshot", "updated_at")
VALUES
    ('${RECORD_ID}', '${VERSION_ID}', '${PUBLISHED_COLLECTION_ID}', '小红书', now(), '标题', now());
`;

const client = new Client({ connectionString: process.env.DATABASE_URL });

/** 照片与资源夹的行数：迁移前后必须一致（AC-DEL-3）。 */
let retainedBefore: { assetCount: string; collectionCount: string };

async function retainedCounts(): Promise<{ assetCount: string; collectionCount: string }> {
  const { rows } = await client.query<{ asset_count: string; collection_count: string }>(`
    SELECT (SELECT count(*) FROM "media_asset")::text AS asset_count,
           (SELECT count(*) FROM "media_collection")::text AS collection_count
  `);
  const row = rows[0];
  if (!row) throw new Error("行数查询没有返回结果");
  return { assetCount: row.asset_count, collectionCount: row.collection_count };
}

beforeAll(async () => {
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.query(`SET search_path TO "${SCHEMA}"`);

  const files = migrationFiles();
  const target = files.indexOf(TARGET_MIGRATION);
  expect(target, `找不到迁移 ${TARGET_MIGRATION}`).toBeGreaterThan(0);

  for (const name of files.slice(0, target)) {
    await client.query(readFileSync(path.join(MIGRATION_DIR, name, "migration.sql"), "utf8"));
  }
  await client.query(SEED);
  retainedBefore = await retainedCounts();
  await client.query(readFileSync(path.join(MIGRATION_DIR, TARGET_MIGRATION, "migration.sql"), "utf8"));
}, 60_000);

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe("AC-DEL-3 下线迁移只删两张表与版本号计数器", () => {
  test("copy_version 与 publish_record 两张表都不存在了", async () => {
    const { rows } = await client.query<{ name: string | null }>(`
      SELECT to_regclass('"copy_version"')::text AS name
      UNION ALL SELECT to_regclass('"publish_record"')::text
      UNION ALL SELECT to_regclass('"copy_version_asset"')::text
    `);
    expect(rows.map((row) => row.name)).toEqual([null, null, null]);
  });

  test("照片与资源夹的行数迁移前后完全一致", async () => {
    expect(await retainedCounts()).toEqual(retainedBefore);
    // 旧数据不是空的：行数不变才有意义。
    expect(retainedBefore).toEqual({ assetCount: "3", collectionCount: "2" });
  });

  test("资源夹上的 copy_version_seq 列已删除", async () => {
    const { rowCount } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'media_collection' AND column_name = 'copy_version_seq'`,
      [SCHEMA],
    );
    expect(rowCount).toBe(0);
  });

  test("只删这两张表：照片、资源夹、关联表、提取运行与素材库都还在", async () => {
    const { rows } = await client.query<{ name: string | null }>(`
      SELECT to_regclass('"media_collection"')::text AS name
      UNION ALL SELECT to_regclass('"media_asset"')::text
      UNION ALL SELECT to_regclass('"collection_asset"')::text
      UNION ALL SELECT to_regclass('"extraction_run"')::text
      UNION ALL SELECT to_regclass('"extraction_item"')::text
      UNION ALL SELECT to_regclass('"library_asset"')::text
    `);
    expect(rows.map((row) => row.name)).toEqual([
      "media_collection",
      "media_asset",
      "collection_asset",
      "extraction_run",
      "extraction_item",
      "library_asset",
    ]);
  });
});
