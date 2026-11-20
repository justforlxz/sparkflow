import { afterAll, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { isEnabled, setFeatureEnabled } from "@/modules/feature-flags/service";

afterAll(async () => {
  await getDb().featureFlag.deleteMany({ where: { key: { in: ["image-to-image", "share-to-xiaohongshu"] } } });
});

test("AC-10-3 未实现的开关直接改库置 true 也不可用（分享）", async () => {
  const db = getDb();
  await db.featureFlag.upsert({
    where: { key: "share-to-xiaohongshu" },
    create: { key: "share-to-xiaohongshu", enabled: true },
    update: { enabled: true },
  });

  await expect(isEnabled("share-to-xiaohongshu")).resolves.toBe(false);

  const row = await db.featureFlag.findUnique({ where: { key: "share-to-xiaohongshu" } });
  expect(row?.enabled).toBe(true);
});

test("AC-10-4 图生图已实现：直接改库置 true 即生效，置 false 即禁用", async () => {
  const db = getDb();
  await db.featureFlag.upsert({
    where: { key: "image-to-image" },
    create: { key: "image-to-image", enabled: true },
    update: { enabled: true },
  });
  await expect(isEnabled("image-to-image")).resolves.toBe(true);

  await db.featureFlag.update({ where: { key: "image-to-image" }, data: { enabled: false } });
  await expect(isEnabled("image-to-image")).resolves.toBe(false);
});

test("AC-S1-4 开启未实现项被拒，且库值不变", async () => {
  const db = getDb();
  await db.featureFlag.upsert({
    where: { key: "share-to-xiaohongshu" },
    create: { key: "share-to-xiaohongshu", enabled: false },
    update: { enabled: false },
  });

  await expect(setFeatureEnabled("share-to-xiaohongshu", true)).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
    status: 400,
    details: { code: "FEATURE_NOT_IMPLEMENTED", feature: "share-to-xiaohongshu" },
  });

  const row = await db.featureFlag.findUnique({ where: { key: "share-to-xiaohongshu" } });
  expect(row?.enabled).toBe(false);
});
