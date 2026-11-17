import { readFile, stat } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { storageRoot } from "@/lib/storage";
import {
  addCollectionAssets,
  createCollection,
  deleteCollection,
  getCollection,
  removeCollectionAsset,
  updateCollectionFields,
} from "@/modules/media-collection/service";

/** 1×1 的 PNG 字节：内容判断只看魔数，集成测试不关心像素。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdIds: string[] = [];

function pngFile(name: string) {
  return { fileName: name, bytes: PNG_BYTES };
}

function assetPath(storageKey: string): string {
  return `${storageRoot()}/${storageKey}`;
}

async function fileExists(storageKey: string): Promise<boolean> {
  try {
    await stat(assetPath(storageKey));
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  // 每个用例自带清理：资源夹与图片记录都删掉，磁盘目录由 service 处理。
  for (const id of createdIds.splice(0)) {
    await getDb().mediaCollection.deleteMany({ where: { id } });
  }
});

test("AC-01-1 两张图片落库后按上传顺序返回，文件写在 media-assets/<collectionId>/ 下", async () => {
  const created = await createCollection(
    { name: "集成-两张图", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("a.png"), pngFile("b.png")],
  );
  createdIds.push(created.id);

  expect(created.assets).toHaveLength(2);
  expect(created.assets.map((asset) => asset.fileName)).toEqual(["a.png", "b.png"]);
  expect(created.assets.map((asset) => asset.sortOrder)).toEqual([0, 1]);

  const rows = await getDb().mediaAsset.findMany({
    where: { collectionId: created.id },
    select: { storageKey: true },
  });
  for (const row of rows) {
    expect(row.storageKey).toMatch(
      new RegExp(`^media-assets/${created.id}/[0-9a-f-]{36}\\.png$`),
    );
    expect(await fileExists(row.storageKey)).toBe(true);
  }
});

test("AC-01-4 只改来源信息时图片数量与内容不变", async () => {
  const created = await createCollection(
    { name: "集成-改来源", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("a.png"), pngFile("b.png")],
  );
  createdIds.push(created.id);

  const updated = await updateCollectionFields(created.id, {
    name: "集成-改来源-新名字",
    platform: "小红书",
    sourceUrl: "https://example.com/note/1",
    sourceTitle: "原始标题",
    sourceBody: "原始文案",
  });

  expect(updated.name).toBe("集成-改来源-新名字");
  expect(updated.platform).toBe("小红书");
  expect(updated.assets.map((asset) => asset.id)).toEqual(created.assets.map((asset) => asset.id));
});

test("AC-01-5 解除关联只删记录，磁盘文件仍在，其余图片不受影响", async () => {
  const created = await createCollection(
    { name: "集成-解除关联", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("a.png"), pngFile("b.png")],
  );
  createdIds.push(created.id);

  const [first, second] = created.assets;
  const stored = await getDb().mediaAsset.findUnique({
    where: { id: first.id },
    select: { storageKey: true },
  });

  const afterRemove = await removeCollectionAsset(created.id, first.id);

  expect(afterRemove.assets.map((asset) => asset.id)).toEqual([second.id]);
  expect(await fileExists(stored?.storageKey ?? "")).toBe(true);
  // MUST 4：文件还能按原 storage_key 读出来。
  await expect(readFile(assetPath(stored?.storageKey ?? ""))).resolves.toHaveLength(PNG_BYTES.length);
});

test("AC-01-6 删除资源夹后图片记录级联消失，磁盘目录被清理", async () => {
  const created = await createCollection(
    { name: "集成-删除", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("a.png"), pngFile("b.png")],
  );
  createdIds.push(created.id);

  const rows = await getDb().mediaAsset.findMany({
    where: { collectionId: created.id },
    select: { storageKey: true },
  });

  await deleteCollection(created.id);

  expect(await getDb().mediaCollection.count({ where: { id: created.id } })).toBe(0);
  expect(await getDb().mediaAsset.count({ where: { collectionId: created.id } })).toBe(0);
  for (const row of rows) {
    expect(await fileExists(row.storageKey)).toBe(false);
  }
  await expect(getCollection(created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("追加图片接在现有顺序之后，排序不重叠", async () => {
  const created = await createCollection(
    { name: "集成-追加", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("a.png")],
  );
  createdIds.push(created.id);

  const appended = await addCollectionAssets(created.id, [pngFile("b.png"), pngFile("c.png")]);

  expect(appended.assets.map((asset) => asset.fileName)).toEqual(["a.png", "b.png", "c.png"]);
  expect(appended.assets.map((asset) => asset.sortOrder)).toEqual([0, 1, 2]);
});

test("最后一张图片不能被解除关联（MUST 1）", async () => {
  const created = await createCollection(
    { name: "集成-最后一张", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("only.png")],
  );
  createdIds.push(created.id);

  await expect(removeCollectionAsset(created.id, created.assets[0].id)).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
  });
  expect(await getDb().mediaAsset.count({ where: { collectionId: created.id } })).toBe(1);
});
