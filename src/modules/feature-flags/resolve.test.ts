import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS, findFeatureFlag } from "./registry";
import { resolveFeatureFlag } from "./resolve";

describe("功能开关生效规则（AC-S1-5）", () => {
  const implementedEntry = {
    key: "image-to-image",
    name: "图生图",
    description: "已实现时的样例",
    defaultEnabled: false,
    implemented: true,
    affects: [],
    disabledMessage: "该功能未启用",
  } as const;

  const unimplementedEntry = { ...implementedEntry, implemented: false } as const;

  it("已实现且数据库为 true 时可用", () => {
    const resolved = resolveFeatureFlag(implementedEntry, { enabled: true });
    expect(resolved).toMatchObject({ enabled: true, active: true });
  });

  it("已实现但数据库为 false 时不可用", () => {
    expect(resolveFeatureFlag(implementedEntry, { enabled: false }).active).toBe(false);
  });

  it("缺行时用注册表默认值", () => {
    expect(resolveFeatureFlag(implementedEntry, null).enabled).toBe(false);
    expect(
      resolveFeatureFlag({ ...implementedEntry, defaultEnabled: true }, null).active,
    ).toBe(true);
  });

  it("未实现时即使数据库 enabled=true 也不可用", () => {
    const resolved = resolveFeatureFlag(unimplementedEntry, { enabled: true });
    expect(resolved.enabled).toBe(true);
    expect(resolved.active).toBe(false);
  });

  it("第一版注册表只有两项且都未实现", () => {
    expect(FEATURE_FLAGS.map((entry) => entry.key)).toEqual([
      "image-to-image",
      "share-to-xiaohongshu",
    ]);
    expect(FEATURE_FLAGS.every((entry) => entry.implemented === false)).toBe(true);
    expect(findFeatureFlag("not-registered")).toBeUndefined();
  });
});
