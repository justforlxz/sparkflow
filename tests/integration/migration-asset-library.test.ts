import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例（ADR 0010 第 6 条、MKACG-944 AC-MIG-1）：历史结果迁成文案版本后，版本里记的素材 id
 * 必须指向 `library_asset` 里真实存在的行，而且正是该条结果迁出来的那几张素材。
 *
 * 做法：在独立 schema 里按名字顺序重放「本次迁移之前」的全部旧迁移 → 灌一份旧模型数据 →
 * 只执行本次迁移 → 回读断言。独立 schema 是为了不碰其它集成用例在 public 里的数据。
 *
 * 这条用例测的是 SQL 本身：把 `selected_asset_ids` 写成原图 id（`media_asset.id`）也能过 schema、
 * 过接口，只有回读素材库才能发现界面会把存在的素材显示成「已删除素材」。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** 被测迁移：数据层重构 + 历史数据迁移。之前的迁移都是旧模型。 */
const TARGET_MIGRATION = "20261121140000_asset_library_copy_versions";
const SCHEMA = "migration_check";

const COLLECTION_WITH_ASSETS = "mig-a-collection";
const COLLECTION_COPY_MISSING = "mig-b-collection";

const GENERATED_ASSET_IDS = ["mig-a-gen-1", "mig-a-gen-2", "mig-a-gen-3"];

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 旧模型数据（第 12 条迁移之前）：两个资源夹、两条结果、一条结果带 3 张生成图。 */
const LEGACY_SEED = `
INSERT INTO "media_collection" ("id", "name", "updated_at") VALUES
    ('${COLLECTION_WITH_ASSETS}', '迁移用例-有素材', now()),
    ('${COLLECTION_COPY_MISSING}', '迁移用例-文案失败', now());

INSERT INTO "media_asset" ("id", "collection_id", "storage_key", "file_name", "mime_type", "size", "sort_order")
VALUES
    ('mig-a-img-1', '${COLLECTION_WITH_ASSETS}', 'media/a-1.png', 'a-1.png', 'image/png', 1, 0),
    ('mig-a-img-2', '${COLLECTION_WITH_ASSETS}', 'media/a-2.png', 'a-2.png', 'image/png', 1, 1);

INSERT INTO "generation_task" ("id", "collection_id", "visual_style", "copy_style", "extra_prompt", "agent_snapshot")
VALUES
    ('mig-a-task', '${COLLECTION_WITH_ASSETS}', 'warm', 'story', NULL, '{}'::JSONB),
    ('mig-b-task', '${COLLECTION_COPY_MISSING}', 'warm', 'story', NULL, '{}'::JSONB);

INSERT INTO "generation_stage" ("id", "task_id", "stage", "status", "finished_at")
VALUES
    ('mig-a-stage-image', 'mig-a-task', 'image', 'succeeded', now()),
    ('mig-a-stage-copy', 'mig-a-task', 'copy', 'succeeded', now()),
    ('mig-b-stage-image', 'mig-b-task', 'image', 'succeeded', now()),
    ('mig-b-stage-copy', 'mig-b-task', 'copy', 'failed', now());

-- 结果与任务一对一（旧模型）；第二条结果的文案阶段失败，标题与正文都为空。
INSERT INTO "generation_result" ("id", "task_id", "collection_id", "title", "body", "tags", "visual_style")
VALUES
    ('mig-a-result', 'mig-a-task', '${COLLECTION_WITH_ASSETS}', '标题 A', '正文 A', ARRAY['#标签A'], 'warm'),
    ('mig-b-result', 'mig-b-task', '${COLLECTION_COPY_MISSING}', NULL, NULL, ARRAY[]::TEXT[], 'warm');

-- 故意按倒序插入：没有 ORDER BY 的 array_agg 会按插入顺序返回，断言才有意义。
-- 第 3 张的 source_asset_id 为空（旧模型允许原图被解除关联），迁移后它仍然有素材库行。
INSERT INTO "generated_asset"
    ("id", "result_id", "storage_key", "file_name", "mime_type", "sort_order", "source_asset_id")
VALUES
    ('mig-a-gen-3', 'mig-a-result', 'generated/a-3.png', 'a-3.png', 'image/png', 2, NULL),
    ('mig-a-gen-2', 'mig-a-result', 'generated/a-2.png', 'a-2.png', 'image/png', 1, 'mig-a-img-2'),
    ('mig-a-gen-1', 'mig-a-result', 'generated/a-1.png', 'a-1.png', 'image/png', 0, 'mig-a-img-1');

INSERT INTO "publish_record"
    ("id", "result_id", "collection_id", "platform", "published_at", "title_snapshot", "updated_at")
VALUES
    ('mig-a-publish', 'mig-a-result', '${COLLECTION_WITH_ASSETS}', 'xiaohongshu', now(), '标题 A', now());
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

describe("AC-MIG-1 历史结果迁移后，版本里记的素材 id 都指向素材库里的真实行", () => {
  test("AC-MIG-1 每条版本引用的素材都在 library_asset 里", async () => {
    const unresolved = await client.query<{ count: string }>(`
      SELECT count(*) AS count
      FROM "copy_version" v
      WHERE EXISTS (
          SELECT 1 FROM unnest(v."selected_asset_ids") AS x(id)
          WHERE NOT EXISTS (SELECT 1 FROM "library_asset" la WHERE la.id = x.id)
      )
    `);
    expect(unresolved.rows[0].count).toBe("0");
  });

  test("AC-MIG-1 版本记的是该结果迁出来的素材 id（按旧排序），不是原图 id", async () => {
    const versions = await client.query<{ id: string; selected_asset_ids: string[] }>(`
      SELECT "id", "selected_asset_ids" FROM "copy_version" ORDER BY "id"
    `);
    const byId = new Map(versions.rows.map((row) => [row.id, row.selected_asset_ids]));

    // 旧模型里生成图的 id 原样成为素材 id，顺序按旧 sort_order。
    expect(byId.get("mig-a-result")).toEqual(GENERATED_ASSET_IDS);
    // 文案阶段失败的结果没有生成图，版本里没有素材，而不是把原图 id 塞进去。
    expect(byId.get("mig-b-result")).toEqual([]);
  });

  test("AC-MIG-1 素材库行的 id 就是旧生成图的 id，与版本引用对得上", async () => {
    const assets = await client.query<{ id: string; source_asset_id: string; category: string }>(`
      SELECT "id", "source_asset_id", "category"
      FROM "library_asset"
      WHERE "collection_id" = $1
      ORDER BY "sort_order", "id"
    `, [COLLECTION_WITH_ASSETS]);

    expect(assets.rows.map((row) => row.id)).toEqual(GENERATED_ASSET_IDS);
    expect(assets.rows.map((row) => row.source_asset_id)).toEqual(["mig-a-img-1", "mig-a-img-2", "mig-a-img-1"]);
    expect(new Set(assets.rows.map((row) => row.category))).toEqual(new Set(["other"]));
  });

  test("AC-MIG-1 发布记录改挂文案版本，旧表与 extract_target 都已删除", async () => {
    const publish = await client.query<{ copy_version_id: string }>(
      `SELECT "copy_version_id" FROM "publish_record" WHERE "id" = 'mig-a-publish'`,
    );
    expect(publish.rows[0].copy_version_id).toBe("mig-a-result");

    const legacy = await client.query<{ name: string | null }>(`
      SELECT to_regclass('"generation_result"')::text AS name
      UNION ALL SELECT to_regclass('"generation_task"')::text
      UNION ALL SELECT to_regclass('"generation_stage"')::text
      UNION ALL SELECT to_regclass('"generated_asset"')::text
    `);
    expect(legacy.rows.map((row) => row.name)).toEqual([null, null, null, null]);

    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'media_collection' AND column_name = 'extract_target'
    `, [SCHEMA]);
    expect(columns.rowCount).toBe(0);
  });
});
