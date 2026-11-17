import { afterAll, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { isEnabled, setFeatureEnabled } from "@/modules/feature-flags/service";

afterAll(async () => {
  await getDb().featureFlag.deleteMany({ where: { key: { in: ["image-to-image", "share-to-xiaohongshu"] } } });
});

test("AC-S1-5 直接改库把 image-to-image.enabled 置 true 后 isEnabled 仍为 false", async () => {
  const db = getDb();
  await db.featureFlag.upsert({
    where: { key: "image-to-image" },
    create: { key: "image-to-image", enabled: true },
    update: { enabled: true },
  });

  await expect(isEnabled("image-to-image")).resolves.toBe(false);

  const row = await db.featureFlag.findUnique({ where: { key: "image-to-image" } });
  expect(row?.enabled).toBe(true);
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
