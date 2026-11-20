import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TYPES } from "./constants";
import { AGENT_DEFAULTS } from "./defaults";

const MIGRATIONS_DIR = "prisma/migrations";

/** 迁移里的 SQL 字符串转义（默认文案里没有单引号，这里只是兜底）。 */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 预置文案写在迁移里。已应用过的迁移不改写，文案变更由后续迁移覆盖预置行，
 * 所以把所有迁移按顺序拼起来比对：每一项默认文案都必须能在其中找到。
 */
function presetSql(): string {
  return readdirSync(path.join(process.cwd(), MIGRATIONS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) =>
      readFileSync(path.join(process.cwd(), MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
    )
    .join("\n");
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

describe("图片 Agent 的默认输出要求（AC-WM-1）", () => {
  const text = AGENT_DEFAULTS.image.outputRequirements;

  it("不再要求「按目标张数」与「不要加水印」", () => {
    expect(text).not.toContain("目标张数");
    expect(text).not.toContain("不要加水印");
  });

  it("保留「完整可用」与「不要拼接」，并说明每张原图各生成一张成品图", () => {
    expect(text).toContain("完整可用");
    expect(text).toContain("不要拼接");
    expect(text).toContain("每张原图各生成一张");
  });
});

describe("迁移预置的默认文案与 defaults.ts 一致（防止两处漂移）", () => {
  const sql = presetSql();

  it.each(Object.entries(AGENT_DEFAULTS))("%s 的每一项默认文案都在迁移里", (type, defaults) => {
    expect(sql).toContain(`'${type}'`);
    for (const [field, value] of Object.entries(defaults)) {
      expect(sql, `${type}.${field} 与迁移不一致`).toContain(sqlLiteral(value));
    }
  });
});
