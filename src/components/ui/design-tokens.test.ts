import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 设计系统的回归护栏（ADR 0007、MKACG-913）。
 *
 * - AC-D-1：页面源码里不出现 Tailwind 默认色阶。
 * - AC-D-2：`docs/design/tokens.md` 与 `globals.css` 的变量一一对应。
 * - AC-D-6：正文 ≥4.5:1、大字号与控件边框 ≥3:1，比值由变量值当场计算，不信文档里的数字。
 *
 * 检查对象是源码文本与设计变量本身，不依赖浏览器；浏览器里的真实取色由
 * `tests/e2e/design.spec.ts` 覆盖焦点、悬停与窄屏，两处互补。
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GLOBALS_CSS = readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");
const TOKENS_DOC = readFileSync(path.join(ROOT, "docs/design/tokens.md"), "utf8");
const COMPONENTS_DOC = readFileSync(path.join(ROOT, "docs/design/components.md"), "utf8");

/** `globals.css` 里 `:root { … }` 的变量声明（与 `@theme inline` 的映射分开取，前者才是字面值来源）。 */
function rootDeclarations(): Map<string, string> {
  const block = GLOBALS_CSS.split(":root {")[1]?.split("}")[0] ?? "";
  const declarations = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

function themeDeclarations(): Map<string, string> {
  const block = GLOBALS_CSS.split("@theme inline {")[1]?.split("\n}")[0] ?? "";
  const declarations = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

/** 文档里以反引号写出的变量名。 */
function documentedIn(doc: string): Set<string> {
  return new Set([...doc.matchAll(/`(--[a-z0-9-]+)`/g)].map((match) => match[1]));
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, visit);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) visit(full);
  }
}

interface SourceFile {
  file: string;
  source: string;
  isTest: boolean;
}

function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  walk(path.join(ROOT, "src"), (file) => {
    files.push({
      file: path.relative(ROOT, file),
      source: readFileSync(file, "utf8"),
      isTest: /\.test\.(ts|tsx)$/.test(file),
    });
  });
  return files;
}

const PALETTES = [
  "zinc",
  "gray",
  "slate",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

/** AC-D-1 原文的检查：默认色阶（含颜色深浅数字）。 */
const AC_D1 = new RegExp(`(?:${PALETTES.join("|")})-[0-9]{2,3}`, "g");
/** 更宽的检查：任何带前后缀的默认色阶都算（含 hover:/focus: 前缀与 border-t- 这类方向前缀）。 */
const ANY_PALETTE = new RegExp(
  `[a-z-]*(?:${PALETTES.join("|")})-[0-9]{2,3}(?:/[0-9]{1,3})?`,
  "g",
);
/** ADR 0007 第 2 条：不用 Tailwind 默认字号阶梯。 */
const DEFAULT_TEXT_SCALE = /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g;
/** ADR 0007 第 3 条：阴影只有一档。 */
const DEFAULT_SHADOWS = /\bshadow-(?:2xs|xs|sm|md|lg|xl|2xl|inner)\b/g;

function collect(files: SourceFile[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const { file, source } of files) {
    for (const match of source.matchAll(pattern)) {
      hits.push(`${file}: ${match[0]}`);
    }
  }
  return hits;
}

describe("AC-D-1 页面源码只用设计变量", () => {
  it("src 里不存在 Tailwind 默认色阶（含 hover/focus 等前缀与测试文件）", () => {
    expect(collect(sourceFiles(), AC_D1)).toEqual([]);
  });

  it("非测试源码里不存在任何形式的默认色阶", () => {
    const production = sourceFiles().filter((entry) => !entry.isTest);
    expect(collect(production, ANY_PALETTE)).toEqual([]);
  });

  it("非测试源码里不写默认字号阶梯与多档阴影", () => {
    const production = sourceFiles().filter((entry) => !entry.isTest);
    expect(collect(production, DEFAULT_TEXT_SCALE)).toEqual([]);
    expect(collect(production, DEFAULT_SHADOWS)).toEqual([]);
  });

  it("颜色字面值只允许出现在 globals.css", () => {
    const production = sourceFiles().filter((entry) => !entry.isTest);
    const offenders = production
      .filter(({ source }) => /#[0-9a-fA-F]{3,8}\b/.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe("AC-D-2 tokens 文档与 globals.css 一一对应", () => {
  it(":root 里的每个变量都在 tokens.md 里，且文档不写多余的 :root 变量", () => {
    const root = rootDeclarations();
    const documented = documentedIn(TOKENS_DOC);

    const missingInDoc = [...root.keys()].filter((name) => !documented.has(name));
    expect(missingInDoc, "globals.css 有、tokens.md 缺").toEqual([]);

    // 文档里用反引号写出的 `--x`，除了 @theme 里才有的字号/圆角/阴影/动效与映射名、通配写法，
    // 都必须真的存在于 :root。
    const THEME_ONLY = ["--color-", "--text-", "--radius-", "--shadow-", "--default-"];
    const documentedRootLike = [...documented].filter(
      (name) =>
        !THEME_ONLY.some((prefix) => name.startsWith(prefix)) &&
        !name.endsWith("--line-height") &&
        !name.includes("-*"),
    );
    const missingInCss = documentedRootLike.filter((name) => !root.has(name));
    expect(missingInCss, "tokens.md 有、globals.css 缺").toEqual([]);
  });

  it("每个颜色变量都有对应的 @theme 映射（class 才能用）", () => {
    const root = rootDeclarations();
    const theme = themeDeclarations();
    const colorTokens = [...root.keys()].filter(
      (name) => !name.startsWith("--text-") && !name.startsWith("--radius-") && !name.startsWith("--shadow-") && !name.startsWith("--default-"),
    );

    for (const name of colorTokens) {
      expect(theme.has(`--color-${name.slice(2)}`), `缺少 --color-${name.slice(2)} 映射`).toBe(true);
      expect(theme.get(`--color-${name.slice(2)}`)).toBe(`var(${name})`);
    }
  });

  it("字号、圆角、阴影、动效变量都在文档里登记", () => {
    const documented = documentedIn(TOKENS_DOC);
    const theme = themeDeclarations();

    const required = [...theme.keys()].filter(
      (name) =>
        (name.startsWith("--text-") && !name.endsWith("--line-height")) ||
        name.startsWith("--radius-") ||
        name.startsWith("--shadow-") ||
        name.startsWith("--default-"),
    );
    expect(required.length).toBeGreaterThan(0);

    const missing = required.filter((name) => !documented.has(name));
    expect(missing, "tokens.md 未登记的 @theme 变量").toEqual([]);
  });

  it("components.md 存在且写到了每个通用组件", () => {
    expect(COMPONENTS_DOC.length).toBeGreaterThan(500);
    for (const name of [
      "Button",
      "INPUT_CLASS",
      "TEXTAREA_CLASS",
      "SELECT_CLASS",
      "CHECKBOX_CLASS",
      "Panel",
      "Pill",
      "Dialog",
      "Toast",
      "EmptyState",
      "LoadingState",
      "ErrorState",
    ]) {
      expect(COMPONENTS_DOC, `components.md 缺少 ${name}`).toContain(name);
    }
  });
});

describe("AC-D-6 对比度", () => {
  const root = rootDeclarations();

  /** 取变量值，允许一层 `var(--x)` 引用（例如 `--status-published: var(--positive)`）。 */
  function valueOf(name: string): string {
    const raw = root.get(name);
    if (!raw) throw new Error(`未定义的设计变量：${name}`);
    const reference = raw.match(/^var\((--[a-z0-9-]+)\)$/);
    return reference ? valueOf(reference[1]) : raw;
  }

  function luminance(hex: string): number {
    const digits = hex.replace("#", "");
    const channels = [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16) / 255);
    const [r, g, b] = channels.map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function ratio(foreground: string, background: string): number {
    const [lighter, darker] = [luminance(valueOf(foreground)), luminance(valueOf(background))].sort(
      (a, b) => b - a,
    );
    return (lighter + 0.05) / (darker + 0.05);
  }

  const TEXT_PAIRS: Array<[string, string]> = [
    ["--ink", "--panel"],
    ["--ink", "--soft"],
    ["--ink-secondary", "--panel"],
    ["--ink-secondary", "--soft"],
    ["--ink-tertiary", "--panel"],
    ["--ink-tertiary", "--soft"],
    ["--on-inverse", "--ink"],
    ["--on-inverse", "--accent-strong"],
    ["--on-inverse", "--danger"],
    ["--on-inverse", "--warning"],
    ["--accent-strong", "--panel"],
    ["--danger", "--danger-soft"],
    ["--warning", "--warning-soft"],
    ["--positive", "--positive-soft"],
    ["--status-draft", "--status-draft-soft"],
    ["--status-generating", "--status-generating-soft"],
    ["--status-pending-publish", "--status-pending-publish-soft"],
    ["--status-published", "--status-published-soft"],
  ];

  const CONTROL_PAIRS: Array<[string, string]> = [
    ["--focus", "--panel"],
    ["--focus", "--bg"],
    ["--control-border", "--panel"],
    ["--control-border", "--bg"],
    ["--accent", "--panel"],
  ];

  it("正文与大字号文字 ≥4.5:1", () => {
    for (const [foreground, background] of TEXT_PAIRS) {
      const measured = ratio(foreground, background);
      expect(measured, `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("控件边框与焦点环 ≥3:1", () => {
    for (const [foreground, background] of CONTROL_PAIRS) {
      const measured = ratio(foreground, background);
      expect(measured, `${foreground} / ${background}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("tokens.md 公布的比值与当场计算结果一致（抽查数据不落灰）", () => {
    for (const [foreground, background] of [...TEXT_PAIRS, ...CONTROL_PAIRS]) {
      const published = ratio(foreground, background).toFixed(2);
      expect(TOKENS_DOC, `tokens.md 未公布 ${foreground} / ${background} 的 ${published}`).toContain(
        published,
      );
    }
  });
});
