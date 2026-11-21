import { readdir, readFile, stat } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { storageRoot } from "@/lib/storage";
import {
  addCollectionAssets,
  createCollection,
  deleteCollection,
  getCollection,
  removeCollectionAsset,
  saveCollectionEdit,
  updateCollectionFields,
} from "@/modules/media-collection/service";
import * as repo from "@/modules/media-collection/repo";

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

test("AC-01-2 不带图片也能建夹：没有图片记录，也不写磁盘", async () => {
  const created = await createCollection(
    { name: "集成-先建夹", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [],
  );
  createdIds.push(created.id);

  expect(created.assetCount).toBe(0);
  expect(created.assets).toEqual([]);
  expect(await getDb().mediaAsset.count({ where: { collectionId: created.id } })).toBe(0);
  expect(await storedFiles(created.id)).toEqual([]);
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

test("最后一张图片可以解除关联，资源夹变成 0 张（AC-01-2）", async () => {
  const created = await createCollection(
    { name: "集成-零张", platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    [pngFile("only.png")],
  );
  createdIds.push(created.id);

  const emptied = await removeCollectionAsset(created.id, created.assets[0].id);
  expect(emptied.assetCount).toBe(0);
  expect(emptied.assets).toEqual([]);
  expect(await getDb().mediaAsset.count({ where: { collectionId: created.id } })).toBe(0);

  // 图片文件仍留在磁盘（MUST 4：只删关联记录）。
  expect(await storedFiles(created.id)).toHaveLength(1);
});

/* ---------- 编辑整组保存（MKACG-870）：一次提交、一个事务、失败不留部分改动 ---------- */

const EDIT_FIELDS = {
  name: "集成-整组保存",
  platform: "小红书",
  sourceUrl: "https://example.com/note/1",
  sourceTitle: "原始标题",
  sourceBody: "原始文案",
};

/** 资源夹目录下的文件名清单：用来断言「磁盘没有新增文件」与「被移除的原图仍留在磁盘」。 */
async function storedFiles(collectionId: string): Promise<string[]> {
  try {
    return (await readdir(assetPath(`media-assets/${collectionId}`))).sort();
  } catch {
    return [];
  }
}

test("AC-FIX-1 两张原图全标待移除 + 添加 1 张新图：保存成功，只剩新图，旧文件仍在磁盘（MUST 4）", async () => {
  const created = await createCollection(EDIT_FIELDS, [pngFile("a.png"), pngFile("b.png")]);
  createdIds.push(created.id);

  const storedBefore = await getDb().mediaAsset.findMany({
    where: { collectionId: created.id },
    select: { storageKey: true },
    orderBy: { sortOrder: "asc" },
  });

  const saved = await saveCollectionEdit(created.id, {
    fields: EDIT_FIELDS,
    assets: [
      { kind: "remove", assetId: created.assets[0].id },
      { kind: "remove", assetId: created.assets[1].id },
      { kind: "add", tempKey: "pending-1" },
    ],
    files: new Map([["pending-1", pngFile("c.png")]]),
  });

  expect(saved.assets.map((asset) => asset.fileName)).toEqual(["c.png"]);
  expect(saved.assets.map((asset) => asset.fileName)).not.toContain("a.png");

  // 旧记录删了，旧文件还在（MUST 4）。
  expect(await getDb().mediaAsset.count({ where: { collectionId: created.id } })).toBe(1);
  for (const row of storedBefore) {
    expect(await fileExists(row.storageKey)).toBe(true);
  }
});

test("AC-FIX-2 新图不合法时保存失败，图片、顺序与来源字段与保存前完全一致，磁盘无新增文件", async () => {
  const created = await createCollection(EDIT_FIELDS, [pngFile("a.png"), pngFile("b.png")]);
  createdIds.push(created.id);

  const filesBefore = await storedFiles(created.id);

  await expect(
    saveCollectionEdit(created.id, {
      fields: { ...EDIT_FIELDS, name: "不该被写入的名称" },
      assets: [
        { kind: "remove", assetId: created.assets[0].id },
        { kind: "remove", assetId: created.assets[1].id },
        { kind: "add", tempKey: "pending-1" },
      ],
      files: new Map([["pending-1", { fileName: "note.txt", bytes: Buffer.from("纯文本内容") }]]),
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

  const after = await getCollection(created.id);
  expect(after.name).toBe(EDIT_FIELDS.name);
  expect(after.assets.map((asset) => asset.id)).toEqual(created.assets.map((asset) => asset.id));
  expect(after.assets.map((asset) => asset.fileName)).toEqual(["a.png", "b.png"]);
  expect(after.assets.map((asset) => asset.sortOrder)).toEqual([0, 1]);
  expect(await storedFiles(created.id)).toEqual(filesBefore);
});

test("AC-01-2 结果集为 0 张时保存成功：来源字段写入、关联全删、磁盘文件保留", async () => {
  const created = await createCollection(EDIT_FIELDS, [pngFile("a.png")]);
  createdIds.push(created.id);
  const filesBefore = await storedFiles(created.id);

  await saveCollectionEdit(created.id, {
    fields: { ...EDIT_FIELDS, name: "改成没有图片" },
    assets: [{ kind: "remove", assetId: created.assets[0].id }],
    files: new Map(),
  });

  const after = await getCollection(created.id);
  expect(after.name).toBe("改成没有图片");
  expect(after.assetCount).toBe(0);
  expect(after.assets).toEqual([]);
  // 被移除的原图文件留在磁盘（MUST 4）。
  expect(await storedFiles(created.id)).toEqual(filesBefore);
});

test("AC-FIX-6 资源夹有运行中的提取时保存返回 CONFLICT 并说明原因", async () => {
  const created = await createCollection(EDIT_FIELDS, [pngFile("a.png")]);
  createdIds.push(created.id);

  // 排队中的提取运行 → 资源夹不可改图（docs/prd/12 MUST 1：此时改图会影响正在进行的提取）。
  await getDb().extractionRun.create({
    data: {
      collectionId: created.id,
      status: "queued",
      requirement: "faithful",
      categories: ["material"],
      sourceAssetIds: [created.assets[0].id],
      progress: { done: 0, total: 1 },
    },
  });

  const filesBefore = await storedFiles(created.id);

  await expect(
    saveCollectionEdit(created.id, {
      fields: EDIT_FIELDS,
      assets: [
        { kind: "keep", assetId: created.assets[0].id },
        { kind: "add", tempKey: "pending-1" },
      ],
      files: new Map([["pending-1", pngFile("c.png")]]),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("运行中的提取") });

  expect(await storedFiles(created.id)).toEqual(filesBefore);
  expect(await getDb().mediaAsset.count({ where: { collectionId: created.id } })).toBe(1);
});

test("AC-FIX-7 图片插入失败时整个事务回滚：来源字段与图片都没变", async () => {
  const created = await createCollection(EDIT_FIELDS, [pngFile("a.png"), pngFile("b.png")]);
  createdIds.push(created.id);

  // 构造插入失败：size 是 int4，超出范围时写库报错；此前的字段更新与删除都已在这个事务里执行。
  await expect(
    repo.saveCollectionEdit(created.id, { ...EDIT_FIELDS, name: "不该被写入的名称" }, {
      keep: [{ assetId: created.assets[1].id, sortOrder: 0 }],
      remove: [created.assets[0].id],
      adds: [
        {
          storageKey: `media-assets/${created.id}/00000000-0000-4000-8000-000000000000.png`,
          fileName: "broken.png",
          mimeType: "image/png",
          size: 2 ** 40,
          sortOrder: 1,
        },
      ],
    }),
  ).rejects.toThrow();

  const after = await getCollection(created.id);
  expect(after.name).toBe(EDIT_FIELDS.name);
  expect(after.assets.map((asset) => asset.id)).toEqual(created.assets.map((asset) => asset.id));
  expect(after.assets.map((asset) => asset.sortOrder)).toEqual([0, 1]);
});

test("AC-FIX-8 保存后的 sort_order 与清单顺序一致，重新读取顺序不变", async () => {
  const created = await createCollection(EDIT_FIELDS, [pngFile("a.png"), pngFile("b.png")]);
  createdIds.push(created.id);

  // 清单：移除 a、保留 b、新增 c → 最终顺序 b、c。
  const saved = await saveCollectionEdit(created.id, {
    fields: EDIT_FIELDS,
    assets: [
      { kind: "remove", assetId: created.assets[0].id },
      { kind: "keep", assetId: created.assets[1].id },
      { kind: "add", tempKey: "pending-1" },
    ],
    files: new Map([["pending-1", pngFile("c.png")]]),
  });

  expect(saved.assets.map((asset) => asset.fileName)).toEqual(["b.png", "c.png"]);
  expect(saved.assets.map((asset) => asset.sortOrder)).toEqual([1, 2]);

  const reread = await getCollection(created.id);
  expect(reread.assets.map((asset) => asset.id)).toEqual(saved.assets.map((asset) => asset.id));
  expect(reread.assets.map((asset) => asset.fileName)).toEqual(["b.png", "c.png"]);
});
