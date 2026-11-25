import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例（MKACG-999 AC-PROG-6）：`extraction_run` 只加一列可空 `current_item_key`，
 * **不删列、不改类型、不回填历史行**，已有行数一条都不变。
 *
 * 做法：在独立 schema 里按名字顺序重放「本次迁移之前」的全部迁移 → 灌几条旧形状的运行
 * （排队中带进度、成功带终态时间）→ 只执行本次迁移 → 回读断言列与行数。
 * 独立 schema 是为了不碰其它集成用例在 public 里的数据。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

const TARGET_MIGRATION = "20261125120000_extraction_run_current_item_key";
const SCHEMA = "migration_current_item_key";

const COLLECTION_ID = "mig-k-collection";

/** 旧形状的运行：一条排队中带进度，一条成功带终态时间与旧列取值。 */
const LEGACY_SEED = `
INSERT INTO "media_collection" ("id", "name", "updated_at") VALUES
    ('${COLLECTION_ID}', '迁移用例-当前条目', now());

INSERT INTO "extraction_run"
    ("id", "collection_id", "status", "requirement", "categories", "source_asset_ids",
     "progress", "extra_prompt", "created_at", "finished_at")
VALUES
    ('mig-k-run-queued', '${COLLECTION_ID}', 'queued', 'faithful',
     ARRAY['topdown', 'texture']::TEXT[], ARRAY['mig-k-img-1']::TEXT[],
     '{"done":0,"total":2}'::jsonb, '只保留干净背景', now(), NULL),
    ('mig-k-run-succeeded', '${COLLECTION_ID}', 'succeeded', 'flatten',
     ARRAY['graphic']::TEXT[], ARRAY['mig-k-img-1', 'mig-k-img-2']::TEXT[],
     NULL, NULL, now(), now());
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

describe("AC-PROG-6 extraction_run 加一列可空 current_item_key", () => {
  test("AC-PROG-6 新列可空、类型是 text；已有运行行数不变，旧列取值原样保留", async () => {
    const column = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(`
      SELECT "data_type", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = $1 AND "table_name" = 'extraction_run' AND "column_name" = 'current_item_key'
    `, [SCHEMA]);

    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]?.data_type).toBe("text");
    expect(column.rows[0]?.is_nullable).toBe("YES");
    // 不回填历史行：没有默认值。
    expect(column.rows[0]?.column_default).toBeNull();

    const runs = await client.query<{
      id: string;
      status: string;
      requirement: string;
      categories: string[];
      progress: unknown;
      extra_prompt: string | null;
      current_item_key: string | null;
    }>(`
      SELECT "id", "status", "requirement", "categories", "progress", "extra_prompt", "current_item_key"
      FROM "extraction_run" WHERE "collection_id" = $1 ORDER BY "id"
    `, [COLLECTION_ID]);

    expect(runs.rows.map((row) => row.id)).toEqual(["mig-k-run-queued", "mig-k-run-succeeded"]);
    expect(runs.rows.every((row) => row.current_item_key === null)).toBe(true);

    const queued = runs.rows[0];
    expect(queued).toMatchObject({
      status: "queued",
      requirement: "faithful",
      categories: ["topdown", "texture"],
      extra_prompt: "只保留干净背景",
    });
    expect(queued?.progress).toEqual({ done: 0, total: 2 });

    const succeeded = runs.rows[1];
    expect(succeeded).toMatchObject({ status: "succeeded", requirement: "flatten" });
    expect(succeeded?.progress).toBeNull();
  });

  test("AC-PROG-6 新列可写入也可清空：老库升级后 worker 能直接使用", async () => {
    await client.query(
      `UPDATE "extraction_run" SET "current_item_key" = $1 WHERE "id" = 'mig-k-run-succeeded'`,
      ["mig-k-img-1|graphic"],
    );
    const written = await client.query<{ current_item_key: string | null }>(
      `SELECT "current_item_key" FROM "extraction_run" WHERE "id" = 'mig-k-run-succeeded'`,
    );
    expect(written.rows[0]?.current_item_key).toBe("mig-k-img-1|graphic");

    await client.query(
      `UPDATE "extraction_run" SET "current_item_key" = NULL WHERE "id" = 'mig-k-run-succeeded'`,
    );
    const cleared = await client.query<{ current_item_key: string | null }>(
      `SELECT "current_item_key" FROM "extraction_run" WHERE "id" = 'mig-k-run-succeeded'`,
    );
    expect(cleared.rows[0]?.current_item_key).toBeNull();
  });
});
