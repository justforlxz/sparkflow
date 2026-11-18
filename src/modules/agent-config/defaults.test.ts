import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TYPES } from "./constants";
import { AGENT_DEFAULTS } from "./defaults";

const MIGRATION_FILE = "prisma/migrations/20261118010000_agent_config/migration.sql";

/** 迁移里的 SQL 字符串转义（默认文案里没有单引号，这里只是兜底）。 */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

describe("两份固定 Agent（MUST 1）", () => {
  it("类型只有 image 与 copy", () => {
    expect(AGENT_TYPES.map((definition) => definition.value)).toEqual(["image", "copy"]);
  });

  it("只有图片 Agent 允许模型留空（MUST 3、MUST 4）", () => {
    expect(AGENT_TYPES.map((definition) => [definition.value, definition.modelRequired])).toEqual([
      ["image", false],
      ["copy", true],
    ]);
  });

  it("候选能力按 MUST 2 过滤", () => {
    const capabilities = Object.fromEntries(
      AGENT_TYPES.map((definition) => [definition.value, [...definition.capabilities]]),
    );

    expect(capabilities).toEqual({ image: ["image"], copy: ["text", "image_input"] });
  });

  it("每个类型都有模型留空的界面说法，界面不再各写一份（MUST 3、AC-03-3）", () => {
    for (const definition of AGENT_TYPES) {
      expect(definition.emptyModelLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("迁移预置的默认文案与 defaults.ts 一致（防止两处漂移）", () => {
  const sql = readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");

  it.each(Object.entries(AGENT_DEFAULTS))("%s 的每一项默认文案都在迁移里", (type, defaults) => {
    expect(sql).toContain(`'${type}'`);
    for (const [field, value] of Object.entries(defaults)) {
      expect(sql, `${type}.${field} 与迁移不一致`).toContain(sqlLiteral(value));
    }
  });
});
