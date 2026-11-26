import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { loginInBrowser } from "./support/auth";
import {
  cleanupLibraryData,
  createCollection,
  createGateway,
  extractAndWait,
  listLibrary,
  prepareAgents,
  uniqueName,
} from "./support/library";

/**
 * 删除素材的界面验收（MKACG-1006、AC-DEL2-1 ~ AC-DEL2-4）。
 *
 * 删除只删素材（`library_asset`）与磁盘上的素材文件，**不动原图**；撤销窗口 5 秒，
 * 窗口内界面先把它当不存在，窗口结束才真的发 `DELETE /api/library/[assetId]`。
 * 这里的断言都落在用户与运维能看见的东西上：格子状态、顶部素材条数、接口条数、
 * 资源夹原图接口还打得开。
 */

async function libraryTotal(request: APIRequestContext, collectionId: string): Promise<number> {
  return (await listLibrary(request, collectionId)).total;
}

/** 资源夹里这些原图在 `media_asset` 里的行数：删除素材不应该改动它们（AC-DEL2-4）。 */
async function mediaAssetCount(assetIds: string[]): Promise<number> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*) FROM "media_asset" WHERE id = ANY($1::text[])',
      [assetIds],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

async function expectOriginalStillServed(
  request: APIRequestContext,
  assetIds: string[],
): Promise<void> {
  for (const assetId of assetIds) {
    const response = await request.get(`/api/files/assets/${assetId}`);
    expect(response.status(), `原图 ${assetId} 应该还打得开`).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/");
  }
}

/** 确认弹窗：标题、正文里的条数与确认按钮都在这里。 */
async function confirmDeletion(page: Page, body: string | RegExp): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /删除素材|只保留最新/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(body);
  await dialog.getByTestId("library-delete-confirm").click();
  await expect(dialog).toBeHidden();
}

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
});

test("AC-DEL2-1 AC-DEL2-4 单条删除：该格变「未提取」、别的格不受影响，原图与磁盘文件不变", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-DEL2-1"), 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture"] });

  const before = await listLibrary(request, collection.id);
  expect(before.total).toBe(2);
  const target = before.groups.find((group) => group.category === "topdown")?.items[0];
  if (!target) throw new Error("提取没有产出桌面俯视图素材");
  const assetsBefore = await mediaAssetCount(collection.assetIds);
  expect(assetsBefore).toBe(1);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const card = page.locator(
    `[data-testid="result-card"][data-source-asset-id="${collection.assetIds[0]}"]`,
  );
  await expect(card.getByTestId("image-thumbnail")).toHaveCount(2);
  await expect(page.getByText("素材库 2 条")).toBeVisible();

  // 格子上直接删除：先二次确认，确认后这一格变「未提取」。
  await card.locator('[data-testid="result-cell-delete"][data-category="topdown"]').click();
  await confirmDeletion(page, "将删除 1 条素材，5 秒内可以撤销。原图与资源夹不受影响。");

  // 被删的那一格变「未提取」，同卡的另一类还留着成品（AC-DEL2-1）。
  await expect(card.getByTestId("image-thumbnail")).toHaveCount(1);
  const idle = card.locator('[data-testid="result-cell"][data-state="idle"][data-category="topdown"]');
  await expect(idle).toHaveText("未提取");
  await expect(
    card.locator('[data-testid="result-cell-delete"][data-category="texture"]'),
  ).toHaveCount(1);
  await expect(page.getByText("素材库 1 条")).toBeVisible();
  // 撤销窗口内的轻提示（AC-DEL2-3 的入口）。
  await expect(page.getByTestId("toast")).toContainText("已删除 1 条素材");
  await expect(page.getByTestId("toast-action")).toHaveText("撤销");

  // 窗口结束才真的删：接口条数掉到 1，素材图片 404。
  await expect.poll(() => libraryTotal(request, collection.id), { timeout: 15_000 }).toBe(1);
  const gone = await request.get(`/api/files/library/${target.id}`);
  expect(gone.status()).toBe(404);

  // 原图不动（AC-DEL2-4）：行数不变，磁盘上的原图仍能读取。
  expect(await mediaAssetCount(collection.assetIds)).toBe(assetsBefore);
  await expectOriginalStillServed(request, collection.assetIds);
});

test("AC-DEL2-2 批量删除：勾选多条 → 确认弹窗 → 列表相应减少", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-DEL2-2"), 2);
  await extractAndWait(request, collection, { categories: ["topdown"] });
  expect(await libraryTotal(request, collection.id)).toBe(2);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const results = page.getByTestId("column-results");
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(2);
  await expect(results.getByTestId("result-selection-count")).toHaveText("已选素材 0 条");

  for (const checkbox of await results.getByTestId("result-cell-select").all()) {
    await checkbox.check();
  }
  await expect(results.getByTestId("result-selection-count")).toHaveText("已选素材 2 条");

  await results.getByTestId("result-delete-selected").click();
  await confirmDeletion(page, "将删除 2 条素材，5 秒内可以撤销。原图与资源夹不受影响。");

  // 两张卡上的格子都变「未提取」（每张卡三类），顶部计数归零，勾选也清空。
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(0);
  for (const card of await results.getByTestId("result-card").all()) {
    await expect(card.locator('[data-testid="result-cell"][data-state="idle"]')).toHaveCount(3);
  }
  await expect(page.getByText("素材库 0 条")).toBeVisible();
  await expect(results.getByTestId("result-selection-count")).toHaveText("已选素材 0 条");

  await expect.poll(() => libraryTotal(request, collection.id), { timeout: 15_000 }).toBe(0);
  await expectOriginalStillServed(request, collection.assetIds);
});

test("AC-DEL2-3 5 秒内撤销：条目回到界面，服务端一直没有删", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-DEL2-3"), 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture"] });

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const card = page.locator(
    `[data-testid="result-card"][data-source-asset-id="${collection.assetIds[0]}"]`,
  );
  await expect(card.getByTestId("image-thumbnail")).toHaveCount(2);

  await card.locator('[data-testid="result-cell-delete"][data-category="texture"]').click();
  await confirmDeletion(page, "将删除 1 条素材，5 秒内可以撤销。原图与资源夹不受影响。");
  await expect(card.getByTestId("image-thumbnail")).toHaveCount(1);

  await page.getByTestId("toast-action").click();
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // 撤销后这一格回到成品，条数也回来。
  await expect(card.getByTestId("image-thumbnail")).toHaveCount(2);
  await expect(page.getByText("素材库 2 条")).toBeVisible();

  // 等过撤销窗口：什么都不该被删掉。
  await page.waitForTimeout(6_000);
  expect(await libraryTotal(request, collection.id)).toBe(2);
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("只保留最新：同一张原图同一类别的重复产物只留最新一条", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-DEL2-keep"), 1);
  await extractAndWait(request, collection, { categories: ["topdown"] });
  // 再跑一次：`library_asset` 每次运行各写一条，同一格堆两条。
  await extractAndWait(request, collection, { categories: ["topdown"] });

  const before = await listLibrary(request, collection.id);
  expect(before.total).toBe(2);
  const items = before.groups.find((group) => group.category === "topdown")?.items ?? [];
  expect(items).toHaveLength(2);
  const newest = [...items].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )[0];

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const results = page.getByTestId("column-results");
  await expect(results.getByTestId("result-keep-latest")).toBeEnabled();
  await results.getByTestId("result-keep-latest").click();
  await confirmDeletion(page, /将删除 1 条重复的旧产物/);

  // 这一格仍是成品（留了一条），顶部条数掉到 1。
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(1);
  await expect(page.getByText("素材库 1 条")).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("已清理 1 条重复素材");

  await expect.poll(() => libraryTotal(request, collection.id), { timeout: 15_000 }).toBe(1);
  const after = await listLibrary(request, collection.id);
  const kept = after.groups.find((group) => group.category === "topdown")?.items ?? [];
  expect(kept.map((item) => item.id)).toEqual([newest.id]);
  // 清完之后没有重复可清：「只保留最新」回到不可点。
  await expect(results.getByTestId("result-keep-latest")).toBeDisabled();
});
