import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
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
 * 页头状态口径与「重跑不叠加」（MKACG-1007 AC-UX-2、AC-UX-3）。
 *
 * AC-UX-2：页头状态由**本夹全部原图**的完成情况推导，不能只看最近一条运行。
 * AC-UX-3：同一（原图 × 类别）只保留最新一条产物，重跑两次条数不变、旧文件不残留。
 */

const ALL_CATEGORIES = ["topdown", "texture", "graphic"];

/**
 * 素材落盘目录，与页面进程解析到同一个位置。
 *
 * Playwright 进程只拿得到 `process.env`，不加载 `src/lib/env.ts`；CI 的 e2e job 也只导出
 * `DATABASE_URL` / `AUTH_SECRET` / `GENERATION_ADAPTER`（`.github/workflows/ci.yml`），
 * 所以直接读 `process.env.UPLOAD_DIR` 会把 `undefined` 交给 `path.join` 而抛 TypeError。
 * 缺省值与 `src/lib/env.ts` 的 `UPLOAD_DIR` 保持一致，两边都以仓库根为相对基准。
 */
function libraryStorageRoot(): string {
  return path.join(path.resolve(process.env.UPLOAD_DIR ?? "./data/uploads"), "library-assets");
}

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
});

test("AC-UX-2 出现 1/3 与 0/3 时页头不是「已完成」，而是「部分完成」", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UX-2"), 5);
  // 2~4 号原图三类都出图（3/3）；1 号只出一类（1/3）；5 号一格没跑（0/3）。
  for (const assetId of collection.assetIds.slice(1, 4)) {
    await extractAndWait(request, { id: collection.id, assetIds: [assetId] }, {
      categories: ALL_CATEGORIES,
    });
  }
  const partialAsset = collection.assetIds[0] as string;
  await extractAndWait(request, { id: collection.id, assetIds: [partialAsset] }, {
    categories: ["topdown"],
  });

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const cards = page.getByTestId("result-card");
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(0).getByTestId("result-card-count")).toHaveText("1/3");
  await expect(cards.nth(4).getByTestId("result-card-count")).toHaveText("0/3");

  // 页头口径：有产物但没齐 →「部分完成」，不再写「已完成」。
  await expect(page.getByTestId("collection-extraction-status")).toHaveText("部分完成");
  const header = page.getByTestId("extraction-run");
  await expect(header).not.toContainText("已完成");
  await expect(header).not.toContainText("已提取");
});

test("AC-UX-2 全部原图每类都出图时页头是「已提取」，一格产物都没有时是「待提取」", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const done = await createCollection(request, uniqueName("AC-UX-2-done"), 2);
  await extractAndWait(request, done, { categories: ALL_CATEGORIES });
  const untouched = await createCollection(request, uniqueName("AC-UX-2-idle"), 2);

  await loginInBrowser(page);

  await page.goto(`/collections/${done.id}`);
  await expect(page.getByTestId("collection-extraction-status")).toHaveText("已提取");

  await page.goto(`/collections/${untouched.id}`);
  await expect(page.getByTestId("collection-extraction-status")).toHaveText("待提取");
  await expect(page.getByTestId("extraction-run")).toHaveCount(0);
});

test("AC-UX-3 同一格连跑两次：条数不增加、界面只显示最新产物、旧文件不残留", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UX-3"), 1);

  const firstRun = await extractAndWait(request, collection, { categories: ["topdown"] });
  const firstLibrary = await listLibrary(request, collection.id);
  expect(firstLibrary.total).toBe(1);
  const firstAssetId = firstLibrary.groups.find((group) => group.category === "topdown")?.items[0]
    ?.id as string;

  const secondRun = await extractAndWait(request, collection, { categories: ["topdown"] });
  const afterRerun = await listLibrary(request, collection.id);
  expect(afterRerun.total, "重跑不叠加：同一格仍只有一条产物").toBe(1);
  const secondAssetId = afterRerun.groups.find((group) => group.category === "topdown")?.items[0]
    ?.id as string;
  expect(secondAssetId, "留下来的必须是这次的新产物").not.toBe(firstAssetId);

  // 旧产物的行已经删掉：它的图片地址 404；新产物的地址还能取到图。
  expect((await request.get(`/api/files/library/${firstAssetId}`)).status()).toBe(404);
  expect((await request.get(`/api/files/library/${secondAssetId}`)).status()).toBe(200);

  // 旧文件也不在磁盘上：第一次运行的目录空，第二次运行的目录里正好一份。
  const filesIn = async (runId: string) => (await readdir(path.join(libraryStorageRoot(), runId)).catch(() => [])).length;
  expect(await filesIn(firstRun.id), "旧产物文件已删除").toBe(0);
  expect(await filesIn(secondRun.id), "新产物文件留着").toBe(1);

  // 界面：一格一张图，条数 1，状态按「只出了 1/3」读作「部分完成」。
  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  const results = page.getByTestId("column-results");
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(1);
  await expect(page.getByText("素材库 1 条")).toBeVisible();
  await expect(page.getByTestId("collection-extraction-status")).toHaveText("部分完成");
});
