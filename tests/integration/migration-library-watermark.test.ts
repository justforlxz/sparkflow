import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例（MKACG-1004）：`library_asset` 只加两列 —— `watermark_removed`（非空、默认 false）
 * 与 `watermark_note`（可空），**不删列、不改类型、不回填**，已有素材行数与取值一条都不变。
 *
 * 做法：在独立 schema 里按名字顺序重放「本次迁移之前」的全部迁移 → 灌一条旧形状的素材
 * （带资源夹与运行外键）→ 只执行本次迁移 → 回读断言列属性与行内容。
 * 独立 schema 是为了不碰其它集成用例在 public 里的数据。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

const TARGET_MIGRATION = "20261125140000_library_asset_watermark";
const SCHEMA = "migration_library_watermark";

const COLLECTION_ID = "mig-w-collection";
const RUN_ID = "mig-w-run";
const ASSET_ID = "mig-w-asset";

/** 旧形状的素材：迁移前 `library_asset` 还没有去水印的两列。 */
const LEGACY_SEED = `
INSERT INTO "media_collection" ("id", "name", "updated_at") VALUES
    ('${COLLECTION_ID}', '迁移用例-去水印', now());

INSERT INTO "extraction_run"
    ("id", "collection_id", "status", "requirement", "categories", "source_asset_ids", "created_at")
VALUES
    ('${RUN_ID}', '${COLLECTION_ID}', 'succeeded', 'faithful',
     ARRAY['topdown']::TEXT[], ARRAY['mig-w-img-1']::TEXT[], now());

INSERT INTO "library_asset"
    ("id", "collection_id", "extraction_run_id", "source_asset_id", "category",
     "storage_key", "file_name", "mime_type", "width", "height", "sort_order", "created_at")
VALUES
    ('${ASSET_ID}', '${COLLECTION_ID}', '${RUN_ID}', 'mig-w-img-1', 'topdown',
     'library-assets/mig-w/1.png', '1.png', 'image/png', 1536, 1536, 1, now());
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

describe("AC-WM-3 library_asset 加两列 watermark_removed / watermark_note", () => {
  test("AC-WM-3 新列属性正确：watermark_removed 非空默认 false，watermark_note 可空", async () => {
    const columns = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `
      SELECT "column_name", "data_type", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = $1 AND "table_name" = 'library_asset'
        AND "column_name" IN ('watermark_removed', 'watermark_note')
      ORDER BY "column_name"
    `,
      [SCHEMA],
    );

    expect(columns.rows).toHaveLength(2);

    const note = columns.rows.find((row) => row.column_name === "watermark_note");
    expect(note).toMatchObject({ data_type: "text", is_nullable: "YES", column_default: null });

    const removed = columns.rows.find((row) => row.column_name === "watermark_removed");
    expect(removed).toMatchObject({ data_type: "boolean", is_nullable: "NO" });
    // 不回填成「已去掉」：老素材确实还带着水印。
    expect(removed?.column_default).toBe("false");
  });

  test("AC-WM-3 老素材行原样保留，两列取默认值（未去水印、无原因）", async () => {
    const rows = await client.query<{
      id: string;
      category: string;
      width: number | null;
      height: number | null;
      watermark_removed: boolean;
      watermark_note: string | null;
    }>(
      `
      SELECT "id", "category", "width", "height", "watermark_removed", "watermark_note"
      FROM "library_asset" WHERE "collection_id" = $1
    `,
      [COLLECTION_ID],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: ASSET_ID,
      category: "topdown",
      width: 1536,
      height: 1536,
      watermark_removed: false,
      watermark_note: null,
    });
  });

  test("AC-WM-3 新列可写入也可清空：老库升级后新产物能直接用", async () => {
    await client.query(
      `UPDATE "library_asset" SET "watermark_removed" = true, "watermark_note" = NULL WHERE "id" = $1`,
      [ASSET_ID],
    );
    const cleared = await client.query<{ watermark_removed: boolean; watermark_note: string | null }>(
      `SELECT "watermark_removed", "watermark_note" FROM "library_asset" WHERE "id" = $1`,
      [ASSET_ID],
    );
    expect(cleared.rows[0]).toMatchObject({ watermark_removed: true, watermark_note: null });

    await client.query(
      `UPDATE "library_asset" SET "watermark_removed" = false, "watermark_note" = $2 WHERE "id" = $1`,
      [ASSET_ID, "未去水印：后处理失败（输入缓冲区不是受支持的图片），已保留原图"],
    );
    const written = await client.query<{ watermark_removed: boolean; watermark_note: string | null }>(
      `SELECT "watermark_removed", "watermark_note" FROM "library_asset" WHERE "id" = $1`,
      [ASSET_ID],
    );
    expect(written.rows[0]?.watermark_removed).toBe(false);
    expect(written.rows[0]?.watermark_note).toContain("未去水印");
  });
});
