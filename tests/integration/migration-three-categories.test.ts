import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例（ADR 0011 第 1 条、AC-LIB-15）：类别换成三类后，历史素材必须归到「其他（历史）」，
 * **数量与迁移前一致**，一条都不丢。
 *
 * 做法：在独立 schema 里按名字顺序重放「本次迁移之前」的全部旧迁移 → 灌一份旧类别数据
 * （material / border / 已经是 other 的）→ 只执行本次迁移 → 回读断言。
 * 独立 schema 是为了不碰其它集成用例在 public 里的数据。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** 被测迁移：新增 extraction_item 表 + 旧类别归到 other。 */
const TARGET_MIGRATION = "20261123030000_extraction_items_three_categories";
const SCHEMA = "migration_three_categories";

const COLLECTION_ID = "mig-c-collection";

/** 旧类别数据：material 两条、border 一条、已经是 other 的一条（迁移不该动它）。 */
const LEGACY_SEED = `
INSERT INTO "media_collection" ("id", "name", "updated_at") VALUES
    ('${COLLECTION_ID}', '迁移用例-三类类别', now());

INSERT INTO "extraction_run"
    ("id", "collection_id", "status", "requirement", "categories", "source_asset_ids", "created_at")
VALUES
    ('mig-c-run', '${COLLECTION_ID}', 'succeeded', 'faithful',
     ARRAY['material', 'border']::TEXT[], ARRAY['mig-c-img']::TEXT[], now());

INSERT INTO "library_asset"
    ("id", "collection_id", "extraction_run_id", "source_asset_id", "category",
     "storage_key", "file_name", "mime_type", "sort_order")
VALUES
    ('mig-c-asset-1', '${COLLECTION_ID}', 'mig-c-run', 'mig-c-img', 'material', 'library-assets/a.png', 'a.png', 'image/png', 1),
    ('mig-c-asset-2', '${COLLECTION_ID}', 'mig-c-run', 'mig-c-img', 'material', 'library-assets/b.png', 'b.png', 'image/png', 2),
    ('mig-c-asset-3', '${COLLECTION_ID}', 'mig-c-run', 'mig-c-img', 'border', 'library-assets/c.png', 'c.png', 'image/png', 3),
    ('mig-c-asset-4', '${COLLECTION_ID}', 'mig-c-run', 'mig-c-img', 'other', 'library-assets/d.png', 'd.png', 'image/png', 4);
`;

const client = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.query(`SET search_path TO "${SCHEMA}"`);

  const files = readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const target = files.indexOf(TARGET_MIGRATION);
  expect(target).toBeGreaterThan(0);

  for (const name of files.slice(0, target)) {
    await client.query(readFileSync(path.join(MIGRATION_DIR, name, "migration.sql"), "utf8"));
  }
  await client.query(LEGACY_SEED);
  await client.query(
    readFileSync(path.join(MIGRATION_DIR, TARGET_MIGRATION, "migration.sql"), "utf8"),
  );
}, 60_000);

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe("AC-LIB-15 旧类别归到「其他（历史）」，数量与迁移前一致", () => {
  test("AC-LIB-15 material / border 都变成 other，已经是 other 的行不受影响", async () => {
    const assets = await client.query<{ id: string; category: string }>(`
      SELECT "id", "category" FROM "library_asset" WHERE "collection_id" = $1 ORDER BY "sort_order"
    `, [COLLECTION_ID]);

    expect(assets.rows.map((row) => row.id)).toEqual([
      "mig-c-asset-1",
      "mig-c-asset-2",
      "mig-c-asset-3",
      "mig-c-asset-4",
    ]);
    expect(new Set(assets.rows.map((row) => row.category))).toEqual(new Set(["other"]));
  });

  test("AC-LIB-15 素材数量与迁移前一致，一条都不丢", async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM "library_asset" WHERE "collection_id" = $1`,
      [COLLECTION_ID],
    );
    expect(rows[0]?.count).toBe("4");
  });

  test("AC-LIB-15 运行的类别清单同样归到 other，且去重", async () => {
    const { rows } = await client.query<{ categories: string[] }>(
      `SELECT "categories" FROM "extraction_run" WHERE "id" = 'mig-c-run'`,
    );
    expect(rows[0]?.categories).toEqual(["other"]);
  });

  test("extraction_item 表已建好，三种结局的列都在", async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'extraction_item'
       ORDER BY column_name`,
      [SCHEMA],
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      "category",
      "created_at",
      "error",
      "extraction_run_id",
      "id",
      "library_asset_id",
      "skip_reason",
      "source_asset_id",
      "status",
    ]);
  });
});
