import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { ensureAccount } from "./support/auth";

/**
 * 总资源库（照片池）与资源夹关联的接口验收
 * （docs/adr/0012-总资源库与资源夹的相册模型.md 第 1 条、MKACG-973 AC-POOL-2 ~ AC-POOL-7）。
 *
 * 只走接口、不开界面：界面在 MKACG-974 才重做，这里证明的是 HTTP 层的语义
 * （路径、状态码、幂等性、总库与夹各自的行数变化）。
 */

/** 1×1 的 PNG：内容判断只看魔数。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface PoolAsset {
  id: string;
  fileName: string;
  collectionIds: string[];
  collectionNames: string[];
}

interface CollectionDetail {
  id: string;
  assets: Array<{ id: string; fileName: string; sortOrder: number }>;
}

const BASE_URL = `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`;

const createdCollectionIds: string[] = [];
const createdPoolAssetIds: string[] = [];

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function png(name: string) {
  return { name, mimeType: "image/png", buffer: PNG_ONE_PIXEL };
}

async function createCollection(
  request: APIRequestContext,
  name: string,
  fileCount = 0,
): Promise<CollectionDetail> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name,
    platform: "小红书",
  };
  for (let index = 0; index < fileCount; index += 1) {
    multipart[`images-${index}`] = png(`a${index}.png`);
  }

  const response = await request.post("/api/collections", { multipart });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { ok: true; data: CollectionDetail };
  createdCollectionIds.push(body.data.id);
  createdPoolAssetIds.push(...body.data.assets.map((asset) => asset.id));
  return body.data;
}

/** 上传到总资源库：只入池，不建关联。 */
async function uploadToPool(request: APIRequestContext, name = "pool.png"): Promise<PoolAsset> {
  const response = await request.post("/api/library/assets", {
    multipart: { "images-0": png(name) },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { ok: true; data: PoolAsset[] };
  createdPoolAssetIds.push(...body.data.map((asset) => asset.id));
  return body.data[0];
}

async function getDetail(request: APIRequestContext, id: string): Promise<CollectionDetail> {
  const response = await request.get(`/api/collections/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { ok: true; data: CollectionDetail }).data;
}

/** 总资源库一共有几张照片（`total` 与列表项分开断言，避免分页把数量截断）。 */
async function poolTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get("/api/library?pageSize=1");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok: true; data: { total: number } };
  return body.data.total;
}

/** 在总资源库列表里按 id 找那张照片；找不到返回 undefined。 */
async function findInPool(request: APIRequestContext, assetId: string): Promise<PoolAsset | undefined> {
  const response = await request.get("/api/library?pageSize=60");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    ok: true;
    data: { items: PoolAsset[]; total: number; page: number; pageSize: number };
  };
  return body.data.items.find((item) => item.id === assetId);
}

test.afterEach(async ({ request }) => {
  await ensureAccount(request);
  for (const id of createdCollectionIds.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }
  // 照片属于池，删夹不会带走它们（AC-POOL-4），用例自己清理。
  for (const id of createdPoolAssetIds.splice(0)) {
    await request.delete(`/api/library/assets/${id}`);
  }
});

test("AC-POOL-2 同一张照片加入两个夹后，总资源库该照片的 collectionNames 有两个", async ({
  request,
}) => {
  await ensureAccount(request);

  const photo = await uploadToPool(request, "shared.png");
  expect(photo.collectionIds).toEqual([]);

  const first = await createCollection(request, uniqueName("POOL-2-A"));
  const second = await createCollection(request, uniqueName("POOL-2-B"));

  for (const collection of [first, second]) {
    const linked = await request.post(`/api/collections/${collection.id}/assets`, {
      data: { assetIds: [photo.id] },
    });
    expect(linked.status()).toBe(200);
  }

  expect((await getDetail(request, first.id)).assets.map((asset) => asset.id)).toEqual([photo.id]);
  expect((await getDetail(request, second.id)).assets.map((asset) => asset.id)).toEqual([photo.id]);

  const listed = await findInPool(request, photo.id);
  expect(listed?.collectionIds).toHaveLength(2);
  expect(listed?.collectionIds).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(listed?.collectionNames).toHaveLength(2);
});

test("AC-POOL-5 重复加入同一张照片到同一夹：第二次成功但夹里仍只有一张", async ({ request }) => {
  await ensureAccount(request);

  const photo = await uploadToPool(request, "dup.png");
  const collection = await createCollection(request, uniqueName("POOL-5"));

  const first = await request.post(`/api/collections/${collection.id}/assets`, {
    data: { assetIds: [photo.id] },
  });
  expect(first.status()).toBe(200);

  const second = await request.post(`/api/collections/${collection.id}/assets`, {
    data: { assetIds: [photo.id] },
  });
  expect(second.status()).toBe(200);

  const detail = await getDetail(request, collection.id);
  expect(detail.assets.map((asset) => asset.id)).toEqual([photo.id]);
});

test("AC-POOL-3 从夹里移除：夹里没有它，总资源库里它还在", async ({ request }) => {
  await ensureAccount(request);

  const collection = await createCollection(request, uniqueName("POOL-3"), 1);
  const [asset] = collection.assets;

  const response = await request.delete(`/api/collections/${collection.id}/assets/${asset.id}`);
  expect(response.status()).toBe(200);

  expect((await getDetail(request, collection.id)).assets).toEqual([]);
  expect(await findInPool(request, asset.id)).toBeDefined();
});

test("AC-POOL-6 夹内上传：一次请求后总库多一张、夹里也多一张", async ({ request }) => {
  await ensureAccount(request);

  const collection = await createCollection(request, uniqueName("POOL-6"));
  const poolBefore = await poolTotal(request);

  const response = await request.post(`/api/collections/${collection.id}/assets/upload`, {
    multipart: { "images-0": png("inside.png") },
  });
  expect(response.status()).toBe(201);

  const body = (await response.json()) as { ok: true; data: CollectionDetail };
  createdPoolAssetIds.push(...body.data.assets.map((asset) => asset.id));

  expect(body.data.assets.map((asset) => asset.fileName)).toEqual(["inside.png"]);
  // 入池 + 建关联各一行。
  expect(await poolTotal(request)).toBe(poolBefore + 1);
  expect(await findInPool(request, body.data.assets[0].id)).toBeDefined();
});

test("AC-POOL-7 从总库删除照片：两个夹都空了，列表里也不再有它", async ({ request }) => {
  await ensureAccount(request);

  const photo = await uploadToPool(request, "gone.png");
  const first = await createCollection(request, uniqueName("POOL-7-A"));
  const second = await createCollection(request, uniqueName("POOL-7-B"));
  for (const collection of [first, second]) {
    await request.post(`/api/collections/${collection.id}/assets`, {
      data: { assetIds: [photo.id] },
    });
  }

  const response = await request.delete(`/api/library/assets/${photo.id}`);
  expect(response.status()).toBe(200);
  createdPoolAssetIds.splice(createdPoolAssetIds.indexOf(photo.id), 1);

  expect(await findInPool(request, photo.id)).toBeUndefined();
  expect((await getDetail(request, first.id)).assets).toEqual([]);
  expect((await getDetail(request, second.id)).assets).toEqual([]);
});

test("加入总库里不存在的照片返回 VALIDATION_FAILED，不建关联", async ({ request }) => {
  await ensureAccount(request);

  const collection = await createCollection(request, uniqueName("POOL-404"));
  const response = await request.post(`/api/collections/${collection.id}/assets`, {
    data: { assetIds: [randomUUID()] },
  });

  expect(response.status()).toBe(400);
  const body = (await response.json()) as { ok: false; error: { code: string } };
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect((await getDetail(request, collection.id)).assets).toEqual([]);
});

test("总资源库接口未登录返回 401 JSON", async ({ request }) => {
  await ensureAccount(request);

  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const listed = await anonymous.get("/api/library");
    expect(listed.status()).toBe(401);
    expect(((await listed.json()) as { ok: false; error: { code: string } }).error.code).toBe(
      "UNAUTHORIZED",
    );

    const uploaded = await anonymous.post("/api/library/assets", {
      multipart: { "images-0": png("anon.png") },
    });
    expect(uploaded.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});
