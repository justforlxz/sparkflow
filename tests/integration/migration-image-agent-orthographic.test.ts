import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AGENT_DEFAULTS } from "@/modules/agent-config/defaults";

/**
 * 迁移用例（AC-PROMPT-4、MKACG-1000）：图片 Agent 的默认提示词改成可判定的正交视图约束。
 *
 * 做法：在独立 schema 里按名字顺序重放「本次迁移之前」的全部旧迁移 → 库里是旧默认文案
 * （`type='image'` 那一行）→ 只执行本次迁移 → 回读断言。
 *
 * 为什么必须测 SQL：线上 `agent_config` 存的是旧文本，只改 `defaults.ts` 对已部署环境无效。
 * `agent_config` 的主键是 `type`，同一类型只能有一行，所以「仍是旧默认」与「用户手改过」
 * 两种状态在同一 schema 里先后各跑一次迁移来覆盖（迁移带旧值条件，可以重复执行）。
 */

const MIGRATION_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** 被测迁移：更新图片 Agent 的默认 system_prompt 与 output_requirements。 */
const TARGET_MIGRATION = "20261125130000_agent_defaults_image_orthographic";
const SCHEMA = "migration_image_agent_orthographic";

/** 迁移前的图片 Agent 默认文案（`20261121020000_agent_defaults_image_extraction` 写入的值）。 */
const OLD_SYSTEM_PROMPT =
  "只做提取，不做重绘：忠实保留目标自身的纹理、材质、图案与颜色，不美化、不改变结构、不添加原图里没有的元素；去掉与目标无关的场景元素（桌面、道具、背景、反光、边缘阴影），把目标拉平成正面视角，四边完整、不带透视畸变；不要添加原图里没有的文字、水印或标识。";
const OLD_OUTPUT_REQUIREMENTS =
  "每张原图各输出一张提取图，画面里只包含提取目标本身；目标居中并铺满画面，边缘干净；不拼接、不加边框、不加文字。";

/** 用户手改过的内容：迁移不该覆盖。 */
const EDITED_SYSTEM_PROMPT = "我们自己改过的系统提示词：只提取桌垫中央的图案。";
const EDITED_OUTPUT_REQUIREMENTS = "我们自己改过的输出要求：只要一张，不要边框。";

/** 文案 Agent 的预置文案（`20261118010000_agent_config` 写入；该行由 MKACG-997 的迁移删除）。 */
const COPY_PRESET_SYSTEM_PROMPT =
  "只依据原始素材与图片描述写作：不照搬原文，不编造参数、价格、功效与个人体验；语气自然、口语化，避免营销套话与夸张承诺。";
const COPY_PRESET_OUTPUT_REQUIREMENTS =
  "输出 JSON：title（不超过 30 字）、body（分段，不少于 80 字）、tags（话题标签，最多 10 个，不带 # 号）。";

/** 可判定的几何词（AC-PROMPT-1）：迁移后的默认文案必须带上这几组。 */
const GEOMETRY_PHRASES = [
  "orthographic",
  "zero perspective",
  "zero foreshortening",
  "exactly horizontal or vertical",
  "no shadows",
] as const;

const client = new Client({ connectionString: process.env.DATABASE_URL });

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function sqlOf(name: string): string {
  return readFileSync(path.join(MIGRATION_DIR, name, "migration.sql"), "utf8");
}

interface AgentRow {
  system_prompt: string;
  output_requirements: string;
}

async function agentRow(type: string): Promise<AgentRow> {
  const result = await client.query<AgentRow>(
    `SELECT "system_prompt", "output_requirements" FROM "agent_config" WHERE "type" = $1`,
    [type],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`agent_config 里没有 type='${type}' 的行`);
  return row;
}

beforeAll(async () => {
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.query(`SET search_path TO "${SCHEMA}"`);

  const files = migrationFiles();
  const target = files.indexOf(TARGET_MIGRATION);
  expect(target).toBeGreaterThan(0);
  for (const name of files.slice(0, target)) {
    await client.query(sqlOf(name));
  }
}, 60_000);

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe("AC-PROMPT-4 图片 Agent 默认提示词的数据迁移", () => {
  test("AC-PROMPT-4 迁移前：库里的图片 Agent 还是旧默认文案", async () => {
    expect(await agentRow("image")).toEqual({
      system_prompt: OLD_SYSTEM_PROMPT,
      output_requirements: OLD_OUTPUT_REQUIREMENTS,
    });
  });

  test("AC-PROMPT-4 仍是旧默认文案的行被更新成新文案，且不再命令模型「铺满画面」", async () => {
    await client.query(sqlOf(TARGET_MIGRATION));

    const row = await agentRow("image");
    expect(row.system_prompt).toBe(AGENT_DEFAULTS.image.systemPrompt);
    expect(row.output_requirements).toBe(AGENT_DEFAULTS.image.outputRequirements);
    expect(row.output_requirements).not.toContain("铺满画面");
    for (const phrase of GEOMETRY_PHRASES) {
      expect(row.system_prompt, `默认系统提示词缺少「${phrase}」`).toContain(phrase);
    }
  });

  test("AC-PROMPT-4 用户手改过的行不变（带旧值条件，不覆盖自定义内容）", async () => {
    await client.query(
      `UPDATE "agent_config" SET "system_prompt" = $1, "output_requirements" = $2 WHERE "type" = 'image'`,
      [EDITED_SYSTEM_PROMPT, EDITED_OUTPUT_REQUIREMENTS],
    );

    await client.query(sqlOf(TARGET_MIGRATION));

    expect(await agentRow("image")).toEqual({
      system_prompt: EDITED_SYSTEM_PROMPT,
      output_requirements: EDITED_OUTPUT_REQUIREMENTS,
    });
  });

  test("AC-PROMPT-4 文案 Agent 那一行不受影响", async () => {
    // 这一行随后由 `20261125140000_drop_copy_agent` 删除，所以这里写死预置文案而不是读 defaults.ts。
    const row = await agentRow("copy");
    expect(row.system_prompt).toBe(COPY_PRESET_SYSTEM_PROMPT);
    expect(row.output_requirements).toBe(COPY_PRESET_OUTPUT_REQUIREMENTS);
  });
});
