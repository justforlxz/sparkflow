import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 媒体资源夹与原始文件的端到端验收（docs/prd/01-media-collection.md AC-01-1 ~ AC-01-7，
 * 以及 MKACG-860 补充的 AC-02-8、AC-02-9）。
 * 每个用例自带数据准备与清理：资源夹名带随机后缀，结束后按 id 删除，不依赖执行顺序。
 */

/** 1×1 的 PNG：内容判断只看魔数，用例不关心像素。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface CollectionAsset {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
  url: string;
}

interface CollectionDetail {
  id: string;
  name: string;
  platform: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
  status: string;
  assetCount: number;
  assets: CollectionAsset[];
}

interface CollectionListBody {
  ok: boolean;
  data: {
    items: Array<{ id: string; name: string; assetCount: number; status: string }>;
    total: number;
    page: number;
    pageSize: number;
  };
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const createdIds: string[] = [];

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function png(name: string) {
  return { name, mimeType: "image/png", buffer: PNG_ONE_PIXEL };
}

const BASE_URL = `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`;

/** 浏览器上下文与 `request` 各自持有 cookie：页面用页面上登录，接口用 ensureAccount。 */
async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function createCollection(
  request: APIRequestContext,
  name: string,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }> = [png("a.png")],
): Promise<CollectionDetail> {
  // Playwright 的 multipart 每个键只能带一个文件，因此按序号拆键；服务端接收所有文件字段。
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name,
    platform: "小红书",
    sourceUrl: "https://example.com/note/1",
    sourceTitle: "原始标题",
    sourceBody: "原始文案",
  };
  files.forEach((file, index) => {
    multipart[`images-${index}`] = file;
  });

  const response = await request.post("/api/collections", { multipart });
  expect(response.status()).toBe(201);

  const body = (await response.json()) as { ok: true; data: CollectionDetail };
  createdIds.push(body.data.id);
  return body.data;
}

async function getDetail(request: APIRequestContext, id: string): Promise<CollectionDetail> {
  const response = await request.get(`/api/collections/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { ok: true; data: CollectionDetail }).data;
}

async function findByName(request: APIRequestContext, name: string): Promise<CollectionListBody> {
  const response = await request.get(`/api/collections?q=${encodeURIComponent(name)}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as CollectionListBody;
}

test.afterEach(async ({ request }) => {
  await ensureAccount(request);
  for (const id of createdIds.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }
});

test("AC-01-1 创建资源夹并上传 2 张图片后，列表与详情都能看到这 2 张图片", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  await loginInBrowser(page);

  const name = uniqueName("AC-01-1");
  await page.goto("/collections");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();

  const dialog = page.getByRole("dialog", { name: "新建媒体资源夹" });
  await dialog.getByLabel("名称").fill(name);
  await dialog.getByLabel("来源平台").fill("小红书");
  await dialog.getByLabel("来源链接").fill("https://example.com/note/1");
  await dialog.getByLabel("原始标题").fill("秋季穿搭 3 套");
  await dialog.getByLabel("原始文案").fill("今天的穿搭记录");
  await dialog.getByLabel("添加图片").setInputFiles([png("a.png"), png("b.png")]);

  // 图片网格的第二种状态：已选但还没上传。
  await expect(dialog.getByText("待添加", { exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  // 列表：卡片显示名称与图片数量。
  const card = page.getByRole("link").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("2 张原图");

  // 搜索与状态筛选都能命中这个资源夹（默认状态是 draft）。
  await page.getByRole("searchbox", { name: "搜索" }).fill(name);
  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByRole("link").filter({ hasText: name }).first()).toBeVisible();

  await page.goto(`/collections?status=draft&q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("link").filter({ hasText: name }).first()).toBeVisible();

  // 详情：两张原图都在，顺序与上传一致。
  await page.getByRole("link").filter({ hasText: name }).first().click();
  await expect(page).toHaveURL(/\/collections\/[0-9a-f-]{36}$/);
  await expect(page.getByAltText("a.png")).toBeVisible();
  await expect(page.getByAltText("b.png")).toBeVisible();
  await expect(page.getByText("原图 2 张")).toBeVisible();

  const found = await findByName(request, name);
  createdIds.push(...found.data.items.map((item) => item.id));
  expect(found.data.total).toBe(1);
});

test("AC-01-2 没有图片时保存被拒绝，返回 VALIDATION_FAILED，页面显示可理解的提示", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  await loginInBrowser(page);

  const name = uniqueName("AC-01-2");
  await page.goto("/collections");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();

  const dialog = page.getByRole("dialog", { name: "新建媒体资源夹" });
  await dialog.getByLabel("名称").fill(name);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "至少需要 1 张原始图片" })).toBeVisible();

  // 服务端同样是判据：不带图片的 multipart 直接 400。
  const response = await request.post("/api/collections", {
    multipart: { name: uniqueName("AC-01-2-api"), platform: "小红书" },
  });
  expect(response.status()).toBe(400);
  const body = (await response.json()) as ErrorBody;
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(body.error.message).toContain("至少需要 1 张原始图片");

  const found = await findByName(request, name);
  expect(found.data.total).toBe(0);
});

test("AC-01-3 上传 .txt 被拒绝，错误信息说明原因", async ({ page, request }) => {
  await ensureAccount(request);
  await loginInBrowser(page);

  const name = uniqueName("AC-01-3");
  await page.goto("/collections");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();

  const dialog = page.getByRole("dialog", { name: "新建媒体资源夹" });
  await dialog.getByLabel("名称").fill(name);
  await dialog
    .getByLabel("添加图片")
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("纯文本内容") });
  await dialog.getByRole("button", { name: "保存" }).click();

  const alert = dialog.getByRole("alert").filter({ hasText: "note.txt" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("只接受 JPEG、PNG、WebP");

  const found = await findByName(request, name);
  expect(found.data.total).toBe(0);
});

test("AC-02-8 上传 .txt 改名成 .png 仍被拒绝（按内容判断类型）", async ({ request }) => {
  await ensureAccount(request);

  const response = await request.post("/api/collections", {
    multipart: {
      name: uniqueName("AC-02-8"),
      images: {
        name: "fake.png",
        mimeType: "image/png",
        buffer: Buffer.from("这其实是文本，不是图片"),
      },
    },
  });

  expect(response.status()).toBe(400);
  const body = (await response.json()) as ErrorBody;
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(body.error.message).toContain("fake.png");
  expect(body.error.message).toContain("以文件内容为准");
});

test("AC-02-9 超过 MAX_UPLOAD_BYTES 的文件被拒绝且提示具体上限", async ({ request }) => {
  await ensureAccount(request);

  // 上限 10 MiB（MAX_UPLOAD_BYTES 默认值）：多带 1 字节的 PNG 内容。
  const oversized = Buffer.concat([PNG_ONE_PIXEL, Buffer.alloc(10 * 1024 * 1024)]);
  const response = await request.post("/api/collections", {
    multipart: {
      name: uniqueName("AC-02-9"),
      images: { name: "big.png", mimeType: "image/png", buffer: oversized },
    },
  });

  expect(response.status()).toBe(400);
  const body = (await response.json()) as ErrorBody;
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(body.error.message).toContain("10 MiB");
  expect(body.error.details).toMatchObject({ maxUploadBytes: 10 * 1024 * 1024 });
});

test("AC-01-4 编辑资源夹只改来源信息时，已有图片全部保留", async ({ page, request }) => {
  await ensureAccount(request);
  const created = await createCollection(request, uniqueName("AC-01-4"), [png("a.png"), png("b.png")]);

  await loginInBrowser(page);
  await page.goto(`/collections/${created.id}`);
  await page.getByRole("button", { name: "编辑" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑" });
  await dialog.getByLabel("原始标题").fill("改过的原始标题");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByAltText("a.png")).toBeVisible();
  await expect(page.getByAltText("b.png")).toBeVisible();

  const detail = await getDetail(request, created.id);
  expect(detail.sourceTitle).toBe("改过的原始标题");
  expect(detail.assets.map((asset) => asset.id)).toEqual(created.assets.map((asset) => asset.id));
  expect(detail.assets.map((asset) => asset.fileName)).toEqual(["a.png", "b.png"]);
});

test("AC-01-5 解除某张原图关联后，该图从详情消失，其余图片不受影响", async ({ page, request }) => {
  await ensureAccount(request);
  const created = await createCollection(request, uniqueName("AC-01-5"), [png("a.png"), png("b.png")]);

  await loginInBrowser(page);
  await page.goto(`/collections/${created.id}`);
  await page.getByRole("button", { name: "编辑" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑" });
  // 第三种状态：待移除，可撤销。
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await expect(dialog.getByText("待移除", { exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "撤销移除", exact: true }).click();
  await expect(dialog.getByText("待移除", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("已保存", { exact: true })).toHaveCount(2);

  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  // 详情只剩另一张；重新加载后依然如此。
  await page.reload();
  await expect(page.getByAltText("b.png")).toBeVisible();
  await expect(page.getByAltText("a.png")).toHaveCount(0);
  await expect(page.getByText("原图 1 张")).toBeVisible();

  const detail = await getDetail(request, created.id);
  expect(detail.assets.map((asset) => asset.fileName)).toEqual(["b.png"]);
});

test("AC-01-6 删除资源夹后，其任务、结果、发布记录在数据库与界面中都不再出现", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  const name = uniqueName("AC-01-6");
  const created = await createCollection(request, name, [png("a.png")]);

  await loginInBrowser(page);
  await page.goto(`/collections/${created.id}`);
  await page.getByRole("button", { name: "删除" }).click();

  const dialog = page.getByRole("dialog", { name: "删除这个资源夹？" });
  await expect(dialog).toContainText("创作任务、结果与发布记录会一并删除");
  await dialog.getByRole("button", { name: "确认删除" }).click();

  await expect(page).toHaveURL("/collections");
  await expect(page.getByRole("link").filter({ hasText: name })).toHaveCount(0);

  const response = await request.get(`/api/collections/${created.id}`);
  expect(response.status()).toBe(404);
  const found = await findByName(request, name);
  expect(found.data.total).toBe(0);
});

test("AC-01-7 图片字节通过 /api/files 返回，content-type 正确；未登录返回 401", async ({
  request,
}) => {
  await ensureAccount(request);
  const created = await createCollection(request, uniqueName("AC-01-7"), [png("a.png")]);
  const asset = created.assets[0];

  const response = await request.get(`/api/files/${created.id}/${asset.id}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect(Buffer.from(await response.body())).toEqual(PNG_ONE_PIXEL);

  // 缩略图参数当场缩放，不改变类型。
  const thumbnail = await request.get(`/api/files/${created.id}/${asset.id}?w=1`);
  expect(thumbnail.status()).toBe(200);
  expect(thumbnail.headers()["content-type"]).toBe("image/png");

  // 没有会话 cookie 时按接口约定返回 401 JSON，而不是图片或 403。
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const denied = await anonymous.get(`/api/files/${created.id}/${asset.id}`);
    expect(denied.status()).toBe(401);
    const body = (await denied.json()) as ErrorBody;
    expect(body.error.code).toBe("UNAUTHORIZED");
  } finally {
    await anonymous.dispose();
  }
});

/* ---------- 编辑整组保存（MKACG-870）：一次请求、整组成功或整组不变 ---------- */

/** 页面上已保存原图的顺序（详情页与编辑弹窗的图片都带 alt=文件名）。 */
async function shownFileNames(scope: Page | Locator): Promise<Array<string | null>> {
  return scope.locator("img[alt]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("alt")),
  );
}

test("AC-FIX-1 2 张原图全标待移除 + 添加 1 张新图：保存成功，详情只剩新图", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  const created = await createCollection(request, uniqueName("AC-FIX-1"), [
    png("a.png"),
    png("b.png"),
  ]);

  await loginInBrowser(page);
  await page.goto(`/collections/${created.id}`);
  await page.getByRole("button", { name: "编辑" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑" });
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await expect(dialog.getByText("待移除", { exact: true })).toHaveCount(2);

  await dialog.getByLabel("添加图片").setInputFiles([png("c.png")]);
  await expect(dialog.getByText("待添加", { exact: true })).toHaveCount(1);

  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText("原图 1 张")).toBeVisible();
  await expect(page.getByAltText("c.png")).toBeVisible();
  await expect(page.getByAltText("a.png")).toHaveCount(0);
  await expect(page.getByAltText("b.png")).toHaveCount(0);

  const detail = await getDetail(request, created.id);
  expect(detail.assets.map((asset) => asset.fileName)).toEqual(["c.png"]);
});

test("AC-FIX-2 新图非法时保存失败，原图数量/顺序与来源字段与保存前完全一致", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  const created = await createCollection(request, uniqueName("AC-FIX-2"), [
    png("a.png"),
    png("b.png"),
  ]);

  await loginInBrowser(page);
  await page.goto(`/collections/${created.id}`);
  await page.getByRole("button", { name: "编辑" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑" });
  await dialog.getByLabel("原始标题").fill("不该被保存的标题");
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await dialog
    .getByLabel("添加图片")
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("纯文本内容") });
  await dialog.getByRole("button", { name: "保存" }).click();

  const alert = dialog.getByRole("alert").filter({ hasText: "note.txt" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("只接受 JPEG、PNG、WebP");

  // 取消后重新加载：图片与来源字段都和保存前一样（磁盘无新增文件由集成测试断言）。
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  expect(await shownFileNames(page)).toEqual(["a.png", "b.png"]);
  await expect(page.getByText("原图 2 张")).toBeVisible();

  const detail = await getDetail(request, created.id);
  expect(detail.sourceTitle).toBe("原始标题");
  expect(detail.assets.map((asset) => asset.id)).toEqual(created.assets.map((asset) => asset.id));
  expect(detail.assets.map((asset) => asset.sortOrder)).toEqual([0, 1]);
});

test("AC-FIX-8 保存后 sort_order 与界面顺序一致，重新打开详情顺序不变", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  const created = await createCollection(request, uniqueName("AC-FIX-8"), [
    png("a.png"),
    png("b.png"),
  ]);

  await loginInBrowser(page);
  await page.goto(`/collections/${created.id}`);
  await page.getByRole("button", { name: "编辑" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑" });
  // 移除第一张（a.png），再追加 c.png → 期望顺序 b、c。
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await dialog.getByLabel("添加图片").setInputFiles([png("c.png")]);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  expect(await shownFileNames(page)).toEqual(["b.png", "c.png"]);

  const detail = await getDetail(request, created.id);
  expect(detail.assets.map((asset) => asset.fileName)).toEqual(["b.png", "c.png"]);
  expect(detail.assets.map((asset) => asset.sortOrder)).toEqual([1, 2]);

  // 重新打开编辑弹窗：已保存图片的展示顺序与保存后一致。
  await page.getByRole("button", { name: "编辑" }).click();
  const reopened = page.getByRole("dialog", { name: "编辑" });
  expect(await shownFileNames(reopened)).toEqual(["b.png", "c.png"]);
  await reopened.getByRole("button", { name: "取消", exact: true }).click();
});
