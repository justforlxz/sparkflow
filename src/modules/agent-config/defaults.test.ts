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

describe("图片 Agent 的默认四项（AC-EX-4、ADR 0009）", () => {
  const image = AGENT_DEFAULTS.image;

  it("四项与 ADR 0009 + MKACG-1000 的定稿逐字一致", () => {
    expect(image).toEqual({
      name: "图片提取 Agent",
      role: "你是一名素材提取师：从原始照片里把指定目标（纹理、材质、图案或主体形象）单独提取出来，做成可以直接使用的素材图。",
      systemPrompt:
        "只做提取，不做重绘：忠实保留目标自身的纹理、材质、图案与颜色，不美化、不改变结构、不添加原图里没有的元素。几何要求：perfectly flat orthographic view、zero perspective、zero foreshortening；目标内的长线、格线与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光、无景深线索。去掉与目标无关的场景元素（桌面、道具、背景、反光、边缘阴影），也不要添加原图里没有的文字、水印或标识。这是材质与图案本身，不是场景（This is a material texture, not a scene）。",
      outputRequirements:
        "每张原图各输出一张提取图，画面里只包含提取目标本身；保持目标自身的真实长宽比，不要为了填满画布而拉伸或裁切；目标之外留纯色空边即可；不拼接、不加边框、不添加原图里没有的文字或水印。",
    });
  });

  it("输出要求不再命令模型「铺满画面」——那等于命令它拉伸（AC-PROMPT-1）", () => {
    expect(image.outputRequirements).not.toContain("铺满画面");
    expect(image.systemPrompt).not.toContain("铺满画面");
    // 反过来要写清「保持自身长宽比」与「不拉伸」。
    expect(image.outputRequirements).toContain("保持目标自身的真实长宽比");
    expect(image.outputRequirements).toContain("拉伸");
  });

  it("不再出现重绘语义的旧措辞", () => {
    for (const text of Object.values(image)) {
      expect(text).not.toContain("视觉方向");
      expect(text).not.toContain("目标张数");
      expect(text).not.toContain("不要加水印");
    }
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
