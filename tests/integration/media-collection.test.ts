import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { storageRoot } from "@/lib/storage";
import {
  addAssetsToCollection,
  createCollection,
  deleteCollection,
  deletePoolAsset,
  getCollection,
  listPoolAssets,
  removeCollectionAsset,
  saveCollectionEdit,
  updateCollectionFields,
  uploadCollectionAssets,
  uploadPoolAssets,
} from "@/modules/media-collection/service";
import * as repo from "@/modules/media-collection/repo";

/**
 * 总资源库（照片池）与资源夹关联的集成验收
 * （docs/adr/0012-总资源库与资源夹的相册模型.md 第 1 条、docs/prd/01-media-collection.md AC-POOL-1 ~ AC-POOL-7）。
 *
 * 这些断言都落在真实 PostgreSQL 上：关联行的级联、多对多的行数、磁盘文件的去留，
 * 用内存替身测不出来。
 */

/** 1×1 的 PNG 字节：内容判断只看魔数，集成测试不关心像素。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdIds: string[] = [];
/** 总资源库里的照片：删资源夹不会带走它们（AC-POOL-4），用例自己清理。 */
const poolAssetIds: string[] = [];

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

/** 建一个资源夹并记住它的照片，供用例结束清理。 */
async function newCollection(
  name: string,
  files: Array<{ fileName: string; bytes: Buffer }> = [],
) {
  const created = await createCollection(
    { name, platform: null, sourceUrl: null, sourceTitle: null, sourceBody: null },
    files,
  );
  createdIds.push(created.id);
  poolAssetIds.push(...created.assets.map((asset) => asset.id));
  return created;
}

/** 直接入池一张照片（不建关联），返回它的 id 与 storage_key。 */
async function newPoolAsset(name = "pool.png") {
  const [asset] = await uploadPoolAssets([pngFile(name)]);
  poolAssetIds.push(asset.id);
  return asset;
}

async function poolAssetCount(): Promise<number> {
  return getDb().mediaAsset.count();
}

async function linkCount(collectionId: string): Promise<number> {
  return getDb().collectionAsset.count({ where: { collectionId } });
}

afterEach(async () => {
  // 每个用例自带清理：资源夹（关联行随外键级联）与池里的照片都删掉。
  for (const id of createdIds.splice(0)) {
    await getDb().mediaCollection.deleteMany({ where: { id } });
  }
  for (const id of poolAssetIds.splice(0)) {
    await getDb().mediaAsset.deleteMany({ where: { id } });
  }
});

test("AC-01-1 两张图片落库后按上传顺序返回，文件写在 media-assets/<assetId>.png 下", async () => {
  const created = await newCollection("集成-两张图", [pngFile("a.png"), pngFile("b.png")]);

  expect(created.assets).toHaveLength(2);
  expect(created.assets.map((asset) => asset.fileName)).toEqual(["a.png", "b.png"]);
  expect(created.assets.map((asset) => asset.sortOrder)).toEqual([0, 1]);

  const rows = await getDb().mediaAsset.findMany({
    where: { id: { in: created.assets.map((asset) => asset.id) } },
    select: { storageKey: true },
  });
  for (const row of rows) {
    // ADR 0012 第 1 条：路径里没有资源夹这一层，照片属于总资源库。
    expect(row.storageKey).toMatch(/^media-assets\/[0-9a-f-]{36}\.png$/);
    expect(await fileExists(row.storageKey)).toBe(true);
  }
});

test("AC-01-2 不带图片也能建夹：没有照片记录，也不写磁盘", async () => {
  const created = await newCollection("集成-先建夹");

  expect(created.assetCount).toBe(0);
  expect(created.assets).toEqual([]);
  expect(await linkCount(created.id)).toBe(0);
});

test("AC-01-4 只改来源信息时图片数量与内容不变", async () => {
  const created = await newCollection("集成-改来源", [pngFile("a.png"), pngFile("b.png")]);

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

test("AC-01-5 / AC-POOL-3 解除关联只删关联行，磁盘文件仍在，其余图片不受影响", async () => {
  const created = await newCollection("集成-解除关联", [pngFile("a.png"), pngFile("b.png")]);
  const poolBefore = await poolAssetCount();

  const [first, second] = created.assets;
  const stored = await getDb().mediaAsset.findUnique({
    where: { id: first.id },
    select: { storageKey: true },
  });

  const afterRemove = await removeCollectionAsset(created.id, first.id);

  expect(afterRemove.assets.map((asset) => asset.id)).toEqual([second.id]);
  // AC-POOL-3：关联行 -1，照片行数不变，磁盘文件仍存在。
  expect(await linkCount(created.id)).toBe(1);
  expect(await poolAssetCount()).toBe(poolBefore);
  expect(await fileExists(stored?.storageKey ?? "")).toBe(true);
  // MUST 4：文件还能按原 storage_key 读出来。
  await expect(readFile(assetPath(stored?.storageKey ?? ""))).resolves.toHaveLength(PNG_BYTES.length);
});

test("AC-POOL-4 删除资源夹：关联行清零，media_asset 行数不变，磁盘文件保留", async () => {
  const created = await newCollection("集成-删除", [pngFile("a.png"), pngFile("b.png")]);
  const poolBefore = await poolAssetCount();

  const rows = await getDb().mediaAsset.findMany({
    where: { id: { in: created.assets.map((asset) => asset.id) } },
    select: { storageKey: true },
  });

  await deleteCollection(created.id);

  expect(await getDb().mediaCollection.count({ where: { id: created.id } })).toBe(0);
  expect(await linkCount(created.id)).toBe(0);
  // 照片留在池里，文件也还在（ADR 0012 第 1 条：删夹只删关联行）。
  expect(await poolAssetCount()).toBe(poolBefore);
  for (const row of rows) {
    expect(await fileExists(row.storageKey)).toBe(true);
  }
  await expect(getCollection(created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("追加图片接在现有顺序之后，排序不重叠", async () => {
  const created = await newCollection("集成-追加", [pngFile("a.png")]);

  const appended = await uploadCollectionAssets(created.id, [pngFile("b.png"), pngFile("c.png")]);
  poolAssetIds.push(...appended.assets.map((asset) => asset.id));

  expect(appended.assets.map((asset) => asset.fileName)).toEqual(["a.png", "b.png", "c.png"]);
  expect(appended.assets.map((asset) => asset.sortOrder)).toEqual([0, 1, 2]);
});

test("最后一张图片可以解除关联，资源夹变成 0 张（AC-01-2）", async () => {
  const created = await newCollection("集成-零张", [pngFile("only.png")]);

  const emptied = await removeCollectionAsset(created.id, created.assets[0].id);
  expect(emptied.assetCount).toBe(0);
  expect(emptied.assets).toEqual([]);
  expect(await linkCount(created.id)).toBe(0);

  // 照片仍在总资源库里（AC-POOL-3）。
  expect(await repo.findAsset(created.assets[0].id)).not.toBeNull();
});

/**
 * AC-POOL-8：删资源夹不能带走「迁移遗留」的旧照片。
 *
 * 必须用旧形状的数据（`collection_id` 非空）才测得到：新路径上传的照片 `collection_id` 是 NULL，
 * 旧外键 `ON DELETE CASCADE` 根本碰不到它们，用新数据跑这条用例等于没测。
 */
test("AC-POOL-8 删除资源夹：迁移遗留的旧照片行数不变，归属被清空为 NULL", async () => {
  const created = await newCollection("集成-旧照片");
  const legacy = await getDb().mediaAsset.create({
    data: {
      collectionId: created.id,
      sortOrder: 0,
      storageKey: `media-assets/legacy-${randomUUID()}.png`,
      fileName: "legacy.png",
      mimeType: "image/png",
      size: PNG_BYTES.length,
    },
    select: { id: true },
  });
  poolAssetIds.push(legacy.id);
  await getDb().collectionAsset.create({
    data: { collectionId: created.id, assetId: legacy.id, sortOrder: 0 },
  });

  const poolBefore = await poolAssetCount();

  await deleteCollection(created.id);

  // 关联行随夹删除，照片行必须留下。旧外键是 CASCADE 时这一步会少一行，断言当场失败。
  expect(await linkCount(created.id)).toBe(0);
  expect(await poolAssetCount()).toBe(poolBefore);

  const survivor = await getDb().mediaAsset.findUnique({
    where: { id: legacy.id },
    select: { collectionId: true },
  });
  expect(survivor).not.toBeNull();
  expect(survivor?.collectionId).toBeNull();
});

/* ---------- 照片池化（AC-POOL-2、AC-POOL-5、AC-POOL-6、AC-POOL-7） ---------- */

test("AC-POOL-2 同一张照片加入两个夹后，两个夹的详情都返回它，总库列表里它有两个夹名", async () => {
  const photo = await newPoolAsset("shared.png");
  const first = await newCollection("集成-相册-A");
  const second = await newCollection("集成-相册-B");

  await addAssetsToCollection(first.id, [photo.id]);
  await addAssetsToCollection(second.id, [photo.id]);

  const firstDetail = await getCollection(first.id);
  const secondDetail = await getCollection(second.id);
  expect(firstDetail.assets.map((asset) => asset.id)).toEqual([photo.id]);
  expect(secondDetail.assets.map((asset) => asset.id)).toEqual([photo.id]);

  const pool = await listPoolAssets({ page: 1, pageSize: 60 });
  const item = pool.items.find((entry) => entry.id === photo.id);
  expect(item?.collectionIds).toHaveLength(2);
  expect(item?.collectionIds).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(item?.collectionNames).toEqual(expect.arrayContaining(["集成-相册-A", "集成-相册-B"]));
});

test("AC-POOL-5 重复加入同一张照片到同一夹：第二次返回成功但关联行不增加", async () => {
  const photo = await newPoolAsset("dup.png");
  const created = await newCollection("集成-幂等");

  await addAssetsToCollection(created.id, [photo.id]);
  expect(await linkCount(created.id)).toBe(1);

  const again = await addAssetsToCollection(created.id, [photo.id]);
  expect(again.assets.map((asset) => asset.id)).toEqual([photo.id]);
  expect(await linkCount(created.id)).toBe(1);
});

test("AC-POOL-5 加入总库里不存在的照片时返回 VALIDATION_FAILED，不建关联", async () => {
  const created = await newCollection("集成-不存在");

  await expect(
    addAssetsToCollection(created.id, ["00000000-0000-4000-8000-000000000000"]),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await linkCount(created.id)).toBe(0);
});

test("AC-POOL-6 夹内上传：一次请求后 media_asset +1 且 collection_asset +1", async () => {
  const created = await newCollection("集成-夹内上传");
  const poolBefore = await poolAssetCount();

  const uploaded = await uploadCollectionAssets(created.id, [pngFile("new.png")]);
  poolAssetIds.push(...uploaded.assets.map((asset) => asset.id));

  expect(await poolAssetCount()).toBe(poolBefore + 1);
  expect(await linkCount(created.id)).toBe(1);
  expect(uploaded.assets.map((asset) => asset.fileName)).toEqual(["new.png"]);
});

test("AC-POOL-7 从总库删除照片：media_asset -1、关联行全删、磁盘文件删除", async () => {
  const photo = await newPoolAsset("gone.png");
  const first = await newCollection("集成-删照片-A");
  const second = await newCollection("集成-删照片-B");
  await addAssetsToCollection(first.id, [photo.id]);
  await addAssetsToCollection(second.id, [photo.id]);

  const stored = await getDb().mediaAsset.findUnique({
    where: { id: photo.id },
    select: { storageKey: true },
  });
  const poolBefore = await poolAssetCount();

  await deletePoolAsset(photo.id);
  poolAssetIds.splice(poolAssetIds.indexOf(photo.id), 1);

  expect(await poolAssetCount()).toBe(poolBefore - 1);
  expect(await linkCount(first.id)).toBe(0);
  expect(await linkCount(second.id)).toBe(0);
  expect(await fileExists(stored?.storageKey ?? "")).toBe(false);
  // 资源夹本身还在，只是空了。
  expect((await getCollection(first.id)).assets).toEqual([]);
});

test("上传到总资源库只入池，不建任何关联", async () => {
  const [asset] = await uploadPoolAssets([pngFile("pool-only.png")]);
  poolAssetIds.push(asset.id);

  expect(asset.collectionIds).toEqual([]);
  expect(asset.collectionNames).toEqual([]);
  expect(await getDb().collectionAsset.count({ where: { assetId: asset.id } })).toBe(0);
  expect(await fileExists(`media-assets/${asset.id}.png`)).toBe(true);
});

/* ---------- 编辑整组保存（MKACG-870）：一次提交、一个事务、失败不留部分改动 ---------- */

const EDIT_FIELDS = {
  name: "集成-整组保存",
  platform: "小红书",
  sourceUrl: "https://example.com/note/1",
  sourceTitle: "原始标题",
  sourceBody: "原始文案",
};

test("AC-FIX-1 两张原图全标待移除 + 添加 1 张新图：保存成功，只剩新图，旧照片仍在总库（MUST 4）", async () => {
  const created = await newCollection("集成-整组保存", [pngFile("a.png"), pngFile("b.png")]);
  const poolBefore = await poolAssetCount();

  const oldIds = created.assets.map((asset) => asset.id);

  const saved = await saveCollectionEdit(created.id, {
    fields: EDIT_FIELDS,
    assets: [
      { kind: "remove", assetId: created.assets[0].id },
      { kind: "remove", assetId: created.assets[1].id },
      { kind: "add", tempKey: "pending-1" },
    ],
    files: new Map([["pending-1", pngFile("c.png")]]),
  });
  poolAssetIds.push(...saved.assets.map((asset) => asset.id));

  expect(saved.assets.map((asset) => asset.fileName)).toEqual(["c.png"]);
  expect(saved.assets.map((asset) => asset.fileName)).not.toContain("a.png");

  // 旧关联删了，旧照片还在池里（AC-POOL-3）。
  expect(await linkCount(created.id)).toBe(1);
  expect(await poolAssetCount()).toBe(poolBefore + 1);
  for (const id of oldIds) {
    expect(await repo.findAsset(id)).not.toBeNull();
  }
});

test("AC-FIX-2 新图不合法时保存失败，图片、顺序与来源字段与保存前完全一致", async () => {
  const created = await newCollection("集成-整组保存", [pngFile("a.png"), pngFile("b.png")]);
  const poolBefore = await poolAssetCount();

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
  expect(await poolAssetCount()).toBe(poolBefore);
});

test("AC-01-2 结果集为 0 张时保存成功：来源字段写入、关联全删、照片留在总库", async () => {
  const created = await newCollection("集成-整组保存", [pngFile("a.png")]);

  await saveCollectionEdit(created.id, {
    fields: { ...EDIT_FIELDS, name: "改成没有图片" },
    assets: [{ kind: "remove", assetId: created.assets[0].id }],
    files: new Map(),
  });

  const after = await getCollection(created.id);
  expect(after.name).toBe("改成没有图片");
  expect(after.assetCount).toBe(0);
  expect(after.assets).toEqual([]);
  expect(await repo.findAsset(created.assets[0].id)).not.toBeNull();
});

test("AC-FIX-6 资源夹有运行中的提取时保存返回 CONFLICT 并说明原因", async () => {
  const created = await newCollection("集成-整组保存", [pngFile("a.png")]);
  const poolBefore = await poolAssetCount();

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

  expect(await poolAssetCount()).toBe(poolBefore);
  expect(await linkCount(created.id)).toBe(1);
});

test("AC-FIX-7 图片插入失败时整个事务回滚：来源字段与图片都没变", async () => {
  const created = await newCollection("集成-整组保存", [pngFile("a.png"), pngFile("b.png")]);

  // 构造插入失败：size 是 int4，超出范围时写库报错；此前的字段更新与删除都已在这个事务里执行。
  await expect(
    repo.saveCollectionEdit(created.id, { ...EDIT_FIELDS, name: "不该被写入的名称" }, {
      keep: [{ assetId: created.assets[1].id, sortOrder: 0 }],
      remove: [created.assets[0].id],
      adds: [
        {
          id: "00000000-0000-4000-8000-000000000000",
          storageKey: "media-assets/00000000-0000-4000-8000-000000000000.png",
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
  const created = await newCollection("集成-整组保存", [pngFile("a.png"), pngFile("b.png")]);

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
  poolAssetIds.push(...saved.assets.map((asset) => asset.id));

  expect(saved.assets.map((asset) => asset.fileName)).toEqual(["b.png", "c.png"]);
  expect(saved.assets.map((asset) => asset.sortOrder)).toEqual([1, 2]);

  const reread = await getCollection(created.id);
  expect(reread.assets.map((asset) => asset.id)).toEqual(saved.assets.map((asset) => asset.id));
  expect(reread.assets.map((asset) => asset.fileName)).toEqual(["b.png", "c.png"]);
});
