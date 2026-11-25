import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * 迁移用例：下线「文案创作 Agent」类型（ADR 0012 第 3 条、MKACG-997 AC-AGENT-2）。
 *
 * 做法与 `migration-drop-copy-and-publish.test.ts` 相同：在独立 schema 里按名字顺序重放
 * 「本次迁移之前」的全部迁移 → 库里是 image 与 copy 各一行 → 只执行本次迁移 → 回读断言。
 * 独立 schema 是为了不碰其它用例在 public 里的数据。
 *
 * 判据是「只删 copy 那一行」：图片提取 Agent 的绑定与提示词必须原样保留。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** 被测迁移：删掉 `agent_config` 里 type='copy' 的那一行。 */
const TARGET_MIGRATION = "20261125140000_drop_copy_agent";
const SCHEMA = "migration_drop_copy_agent";

/** 图片 Agent 的绑定：迁移前后必须一致。 */
const IMAGE_GATEWAY_ID = "drop-copy-gw";

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

interface AgentRow {
  type: string;
  enabled: boolean;
  name: string;
  gateway_id: string | null;
  gateway_model_id: string | null;
  system_prompt: string;
}

async function agentRows(): Promise<AgentRow[]> {
  const { rows } = await client.query<AgentRow>(
    `SELECT "type", "enabled", "name", "gateway_id", "gateway_model_id", "system_prompt"
       FROM "agent_config" ORDER BY "type"`,
  );
  return rows;
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

  // 给图片 Agent 绑一个网关与模型，用来证明这次迁移不碰它。
  await client.query(
    `INSERT INTO "gateway" ("id", "name", "protocol", "base_url", "encrypted_api_key", "updated_at")
     VALUES ($1, '迁移用例网关', 'openai-chat', 'https://gw.example.com/v1', 'x', now())`,
    [IMAGE_GATEWAY_ID],
  );
  await client.query(
    `UPDATE "agent_config" SET "gateway_id" = $1, "gateway_model_id" = 'gpt-image-1'
      WHERE "type" = 'image'`,
    [IMAGE_GATEWAY_ID],
  );
}, 60_000);

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe("AC-AGENT-2 下线「文案创作 Agent」类型的迁移", () => {
  test("迁移前：image 与 copy 各一行", async () => {
    expect((await agentRows()).map((row) => row.type)).toEqual(["copy", "image"]);
  });

  test("迁移后 type='copy' 的行数为 0", async () => {
    await client.query(readFileSync(path.join(MIGRATION_DIR, TARGET_MIGRATION, "migration.sql"), "utf8"));

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "agent_config" WHERE "type" = 'copy'`,
    );
    expect(rows[0]?.count).toBe("0");
  });

  test("type='image' 那一行不受影响：绑定、模型与提示词都还在", async () => {
    const rows = await agentRows();

    expect(rows.map((row) => row.type)).toEqual(["image"]);
    expect(rows[0]).toMatchObject({
      type: "image",
      enabled: true,
      gateway_id: IMAGE_GATEWAY_ID,
      gateway_model_id: "gpt-image-1",
    });
    expect(rows[0]?.system_prompt).toContain("orthographic");
  });
});
