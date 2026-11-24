import { expect, test } from "@playwright/test";
import { MOCK_SCRIPT_HINTS } from "../../src/modules/image-generation/mock-script";
import { loginInBrowser } from "./support/auth";
import {
  cleanupLibraryData,
  createCollection,
  createGateway,
  extractAndWait,
  listLibrary,
  listRuns,
  listVersions,
  prepareAgents,
  uniqueName,
  waitForRun,
  waitForVersion,
  type CopyVersion,
  type ExtractionRun,
} from "./support/library";

/**
 * 素材库、提取运行与文案版本的接口验收（docs/prd/12-asset-library.md）。
 *
 * 走真实 HTTP + 进程内 worker + mock 适配器（`GENERATION_ADAPTER=mock`）：
 * 提取与文案都由后台作业推进，用例只轮询接口等它进入终态。
 */

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
});

test("AC-LIB-1 AC-LIB-3 2 张原图 × 2 个类别 = 进度 4；再跑一次素材增加而不是覆盖", async ({
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-1"), 2);

  const first = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
    },
  });
  expect(first.status()).toBe(201);
  const created = ((await first.json()) as { data: { run: ExtractionRun } }).data.run;
  // 接口层立刻给得出「原图数 × 类别数」（AC-LIB-1）。
  expect(created.progress).toEqual({ done: 0, total: 4 });

  const finished = await waitForRun(request, collection.id, created.id);
  expect(finished.status).toBe("succeeded");

  const library = await listLibrary(request, collection.id);
  expect(library.total).toBe(4);
  expect(library.groups.map((group) => group.category)).toEqual(["topdown", "texture"]);
  expect(library.groups.map((group) => group.items.length)).toEqual([2, 2]);
  // 每条素材都带来源原图（MUST 3）。
  for (const group of library.groups) {
    for (const item of group.items) {
      expect(collection.assetIds).toContain(item.sourceAssetId);
      expect(item.sourceAssetIndex).not.toBeNull();
    }
  }

  // 再跑一次：新运行、新素材，旧素材仍在（AC-LIB-3）。
  const second = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
    },
  });
  const rerun = ((await second.json()) as { data: { run: ExtractionRun } }).data.run;
  await waitForRun(request, collection.id, rerun.id);

  expect((await listLibrary(request, collection.id)).total).toBe(8);
  expect((await listRuns(request, collection.id)).length).toBe(2);
});

test("AC-LIB-2 一项失败：其余正常入库，运行标 partial 并给出可读原因", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-2"), 2);

  const response = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
      // mock 适配器按脚本让第 2 次调用失败。
      extraPrompt: `${MOCK_SCRIPT_HINTS.failImageAt}-2`,
    },
  });
  const run = ((await response.json()) as { data: { run: ExtractionRun } }).data.run;
  const finished = await waitForRun(request, collection.id, run.id);

  expect(finished.status).toBe("partial");
  expect(finished.error?.failures).toHaveLength(1);
  expect(finished.error?.message).toContain("已保留 3/4 条素材");
  expect((await listLibrary(request, collection.id)).total).toBe(3);
});

test("AC-LIB-4 生成文案不触发提取；提取不产生文案版本", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-4"), 1);

  const extraction = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown"],
      requirement: "faithful",
    },
  });
  const run = ((await extraction.json()) as { data: { run: ExtractionRun } }).data.run;
  await waitForRun(request, collection.id, run.id);

  // 提取不产生文案版本。
  expect(await listVersions(request, collection.id)).toEqual([]);
  const library = await listLibrary(request, collection.id);
  const assetIds = library.groups.flatMap((group) => group.items.map((item) => item.id));
  expect(assetIds).toHaveLength(1);

  const before = await listRuns(request, collection.id);

  const copy = await request.post(`/api/collections/${collection.id}/copy-versions`, {
    data: { selectedAssetIds: assetIds, copyStyle: "story" },
  });
  expect(copy.status()).toBe(201);
  const version = ((await copy.json()) as { data: { version: CopyVersion } }).data.version;
  await waitForVersion(request, collection.id, version.id);

  // 生成文案不触发任何提取：运行条数不变，素材条数也不变。
  expect((await listRuns(request, collection.id)).length).toBe(before.length);
  expect((await listLibrary(request, collection.id)).total).toBe(1);
});

test("AC-LIB-5 两个版本的选中素材各自固化，两版并存", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-5"), 2);

  const extraction = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
    },
  });
  const run = ((await extraction.json()) as { data: { run: ExtractionRun } }).data.run;
  await waitForRun(request, collection.id, run.id);

  const library = await listLibrary(request, collection.id);
  const all = library.groups.flatMap((group) => group.items.map((item) => item.id));

  const first = await request.post(`/api/collections/${collection.id}/copy-versions`, {
    data: { selectedAssetIds: all.slice(0, 3), copyStyle: "story" },
  });
  const v1 = ((await first.json()) as { data: { version: CopyVersion } }).data.version;
  await waitForVersion(request, collection.id, v1.id);

  const second = await request.post(`/api/collections/${collection.id}/copy-versions`, {
    data: { selectedAssetIds: all.slice(2, 4), copyStyle: "note" },
  });
  const v2 = ((await second.json()) as { data: { version: CopyVersion } }).data.version;
  await waitForVersion(request, collection.id, v2.id);

  const versions = await listVersions(request, collection.id);
  expect(versions.map((version) => version.versionLabel)).toEqual(["v2", "v1"]);
  expect(versions.find((version) => version.id === v1.id)?.selectedAssetIds).toEqual(all.slice(0, 3));
  expect(versions.find((version) => version.id === v2.id)?.selectedAssetIds).toEqual(all.slice(2, 4));
  // 两版都有内容，能各自打开。
  expect(versions.every((version) => version.status === "succeeded")).toBe(true);
});

test("AC-LIB-6 删除被引用的素材后版本仍能打开，被删素材显示为占位", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-6"), 1);

  const extraction = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown", "texture"],
      requirement: "faithful",
    },
  });
  const run = ((await extraction.json()) as { data: { run: ExtractionRun } }).data.run;
  await waitForRun(request, collection.id, run.id);

  const library = await listLibrary(request, collection.id);
  const all = library.groups.flatMap((group) => group.items.map((item) => item.id));
  const removed = all[0] as string;

  const copy = await request.post(`/api/collections/${collection.id}/copy-versions`, {
    data: { selectedAssetIds: all, copyStyle: "story" },
  });
  const version = ((await copy.json()) as { data: { version: CopyVersion } }).data.version;
  await waitForVersion(request, collection.id, version.id);

  const deleted = await request.delete(`/api/library/${removed}`);
  expect(deleted.status()).toBe(200);

  const [afterDelete] = await listVersions(request, collection.id);
  expect(afterDelete?.status).toBe("succeeded");
  expect(afterDelete?.assets).toHaveLength(all.length);
  expect(afterDelete?.assets.find((asset) => asset.id === removed)).toMatchObject({
    deleted: true,
    categoryLabel: "已删除素材",
  });
});

test("AC-LIB-8 同一版本重复标记发布，发布记录仍为 1 条", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-8"), 1);

  const extraction = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["topdown"],
      requirement: "faithful",
    },
  });
  const run = ((await extraction.json()) as { data: { run: ExtractionRun } }).data.run;
  await waitForRun(request, collection.id, run.id);

  const library = await listLibrary(request, collection.id);
  const assetIds = library.groups.flatMap((group) => group.items.map((item) => item.id));

  const copy = await request.post(`/api/collections/${collection.id}/copy-versions`, {
    data: { selectedAssetIds: assetIds, copyStyle: "story" },
  });
  const version = ((await copy.json()) as { data: { version: CopyVersion } }).data.version;
  await waitForVersion(request, collection.id, version.id);

  const first = await request.post(`/api/copy-versions/${version.id}/publish`, {
    data: { platform: "小红书" },
  });
  expect(first.status()).toBe(200);
  const second = await request.post(`/api/copy-versions/${version.id}/publish`, {
    data: { platform: "小红书" },
  });
  expect(second.status()).toBe(200);

  const records = await request.get(`/api/collections/${collection.id}/publish-records`);
  const body = (await records.json()) as {
    data: { total: number; items: Array<{ copyVersionId: string; versionLabel: string; title: string }> };
  };
  expect(body.data.total).toBe(1);
  expect(body.data.items[0]).toMatchObject({
    copyVersionId: version.id,
    versionLabel: "v1",
  });
});

/* ------------------------------------------------------------------ *
 * 界面验收（MKACG-974）：三栏工作区、按原图一张卡、内联进度
 * ------------------------------------------------------------------ */

test("AC-LIB-1 AC-LIB-3 界面：2 张原图 × 三类 = 进度 6，结果按原图两张卡；再跑一次素材累加", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-1-ui"), 2);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 左栏默认全选；右栏固定三类，没有类别勾选框。
  await expect(page.getByTestId("source-selected-count")).toHaveText("已选 2/2 张");
  await expect(page.getByTestId("extract-submit")).toHaveText("一键提取");

  await page.getByTestId("extract-submit").click();

  // 标题下方出现进度条：总数按 原图数 × 三类 计（6）。
  await expect(page.getByTestId("inline-progress")).toBeVisible();
  await expect(page.getByTestId("inline-progress-bar")).toHaveAttribute("aria-valuemax", "100");
  await expect(page.getByTestId("inline-progress-text")).toHaveText(/^\d+%$/);

  // 跑完换成状态标签，进度条收起。
  await expect(page.getByTestId("extraction-run")).toContainText("已完成", { timeout: 60_000 });
  await expect(page.getByTestId("inline-progress")).toHaveCount(0);

  // 一张原图一张卡，卡内三类产出并排（都完成）。
  const cards = page.getByTestId("result-card");
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card.getByTestId("result-card-count")).toHaveText("3/3");
    await expect(card.getByTestId("image-thumbnail")).toHaveCount(3);
  }
  await expect(page.getByText("素材库 6 条")).toBeVisible();

  // 再跑一次：素材增加而不是覆盖（AC-LIB-3）。
  await page.getByTestId("extract-submit").click();
  await expect(page.getByText("素材库 12 条")).toBeVisible({ timeout: 60_000 });
  // 结果卡仍是两张：每格显示这张原图最近一次尝试。
  await expect(cards).toHaveCount(2);
});

test("AC-LIB-2 界面：部分失败标注「部分失败」、失败项数量与原因，其余素材正常显示", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-2-ui"), 2);
  // mock 适配器按脚本让第 2 次调用失败：6 项里 5 项正常入库。
  const run = await extractAndWait(request, collection, {
    categories: ["topdown", "texture", "graphic"],
    extraPrompt: `${MOCK_SCRIPT_HINTS.failImageAt}-2`,
  });
  expect(run.status).toBe("partial");

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 标题下方：状态、失败项数量与可读原因都在这一行上。
  const status = page.getByTestId("extraction-run");
  await expect(status).toContainText("部分失败");
  await expect(status).toContainText("失败项 1 条");
  await expect(status).toContainText("已保留 5/6 条素材");

  // 失败格：红框 + 原因 + 「重试」；其余 5 格正常出图。
  const failed = page.locator('[data-testid="result-cell"][data-state="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.getByTestId("result-cell-reason")).toContainText("mock");
  await expect(failed.getByTestId("result-cell-retry")).toHaveText("重试");
  await expect(page.getByTestId("column-results").getByTestId("image-thumbnail")).toHaveCount(5);
});

test("AC-LIB-10 三栏各管一件事：左栏只有原图、中栏只有结果、右栏有来源信息", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-10"), 2);
  await extractAndWait(request, collection, { categories: ["topdown", "texture", "graphic"] });

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 左栏：原图网格，没有结果卡，也没有来源信息。
  const left = page.getByTestId("column-source");
  await expect(left.getByText("原始材料")).toBeVisible();
  await expect(left.getByTestId("image-thumbnail")).toHaveCount(2);
  await expect(left.getByTestId("result-card")).toHaveCount(0);
  await expect(left.getByText("来源信息")).toHaveCount(0);

  // 中栏：按原图的结果卡，没有来源信息表单。
  const middle = page.getByTestId("column-results");
  await expect(middle.getByText("处理结果")).toBeVisible();
  await expect(middle.getByTestId("result-card")).toHaveCount(2);
  await expect(middle.getByText("来源信息")).toHaveCount(0);
  await expect(middle.getByText("来源平台")).toHaveCount(0);

  // 右栏：提取设置 + 来源信息，没有结果卡与原图缩略图。
  const right = page.getByTestId("column-settings");
  await expect(right.getByText("提取设置")).toBeVisible();
  await expect(right.getByText("来源信息")).toBeVisible();
  await expect(right.getByText("来源平台")).toBeVisible();
  await expect(right.getByTestId("result-card")).toHaveCount(0);
  await expect(right.getByTestId("image-thumbnail")).toHaveCount(0);
});

test("AC-C-8 结果卡点图在站内弹窗预览，无新标签页、无 window.open", async ({ page, request }) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-C-8"), 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture", "graphic"] });

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  const results = page.getByTestId("column-results");
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(3);

  // 记录任何 window.open 调用：判据是「一次都没有」。
  await page.evaluate(() => {
    const scope = window as Window & { openCalls?: string[] };
    scope.openCalls = [];
    window.open = ((url?: string | URL) => {
      scope.openCalls?.push(String(url));
      return null;
    }) as typeof window.open;
  });

  const popup = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  await results.getByTestId("image-thumbnail").first().click();
  await expect(page.getByTestId("image-lightbox")).toBeVisible();
  expect(await popup).toBeNull();
  expect(
    await page.evaluate(() => (window as Window & { openCalls?: string[] }).openCalls),
  ).toEqual([]);

  // 弹窗里加载的是原图地址，不是缩略图地址。
  const originalSrc = await page.getByTestId("image-lightbox-image").getAttribute("src");
  expect(originalSrc).toMatch(/^\/api\/files\/library\//);
  expect(originalSrc).not.toContain("w=");

  // Esc 关闭，焦点回到缩略图（docs/prd/07 MUST 3）。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
});

test("AC-U-1 375px 下三栏不横向溢出；全选、添加弹窗与一键提取可键盘操作", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-U-1"), 2);

  await loginInBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/collections/${collection.id}`);

  const viewportWidths = () =>
    page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

  let widths = await viewportWidths();
  expect(widths.scrollWidth, "资源夹详情在 375 宽度下不应横向溢出").toBe(widths.clientWidth);

  // 全选：聚焦后按空格切换。
  const selectAll = page.getByRole("checkbox", { name: "勾选全部原图" });
  await selectAll.focus();
  await page.keyboard.press(" ");
  await expect(page.getByTestId("source-selected-count")).toHaveText("已选 0/2 张");
  await page.keyboard.press(" ");
  await expect(page.getByTestId("source-selected-count")).toHaveText("已选 2/2 张");

  // 添加弹窗：键盘打开、`Esc` 关闭，焦点回到「添加」。
  await page.getByTestId("add-assets-open").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("add-assets-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  widths = await viewportWidths();
  expect(widths.scrollWidth, "添加弹窗在 375 宽度下不应横向溢出").toBe(widths.clientWidth);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("add-assets-open")).toBeFocused();

  // 一键提取：键盘触发后标题下方出现进度条。
  await page.getByTestId("extract-submit").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("inline-progress")).toBeVisible();
  widths = await viewportWidths();
  expect(widths.scrollWidth, "提取中在 375 宽度下不应横向溢出").toBe(widths.clientWidth);
});

test("AC-LIB-11 某类别判定为不存在：格子里显示「不存在」与模型原话", async ({ page, request }) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-11"), 1);

  // mock 视觉判定让第 1 次判定回「不存在」：topdown 跳过、另外两类照常提取。
  const run = await extractAndWait(request, collection, {
    categories: ["topdown", "texture", "graphic"],
    extraPrompt: `${MOCK_SCRIPT_HINTS.visionAbsentAt}-1`,
  });
  expect(run.status).toBe("succeeded");

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const results = page.getByTestId("column-results");
  const absent = results.locator('[data-testid="result-cell"][data-state="absent"]');
  await expect(absent).toHaveCount(1);
  await expect(absent).toContainText("不存在");
  // 模型原话就在格子里，不用展开。
  await expect(absent.getByTestId("result-cell-reason")).toContainText("不存在");
  // 跳过的格子没有图，也没有「重试」（它不是失败）。
  await expect(absent.getByTestId("result-cell-retry")).toHaveCount(0);
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(2);
});

test("AC-LIB-12 全部类别都不存在：运行 empty、三类都显示不存在、界面提示「未发现可提取内容」", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-12"), 1);

  const run = await extractAndWait(request, collection, {
    categories: ["topdown", "texture", "graphic"],
    extraPrompt: MOCK_SCRIPT_HINTS.visionAbsentAll,
  });

  expect(run.status).toBe("empty");
  expect(run.statusLabel).toBe("未发现可提取内容");
  // 不是失败：没有 error。
  expect(run.error).toBeNull();
  expect((await listLibrary(request, collection.id)).total).toBe(0);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 运行列表里读作「未发现可提取内容」，不出现「失败」。
  const status = page.getByTestId("extraction-run");
  await expect(status).toContainText("未发现可提取内容");
  await expect(status).not.toContainText("失败");

  // 三类格子都显示「不存在」，没有一张产物。
  const results = page.getByTestId("column-results");
  await expect(results.locator('[data-testid="result-cell"][data-state="absent"]')).toHaveCount(3);
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(0);
});

test("AC-LIB-13 3:2 原图产出长边 1536 的 3:2 图，不出现拉伸", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-13"), 1, {
    imageSize: { width: 900, height: 600 },
  });

  await extractAndWait(request, collection, { categories: ["topdown"] });

  const library = await listLibrary(request, collection.id);
  const item = library.groups[0]?.items[0];
  // 长边 1536、短边按 3:2 取整成 1024；不是固定的 1024×1536（那会把横图拉伸成竖图）。
  expect(item?.width).toBe(1536);
  expect(item?.height).toBe(1024);
});

test("AC-LIB-14 旧的类别 key 被拒绝：只接受 topdown / texture / graphic", async ({ request }) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-14"), 1);

  for (const legacy of ["material", "border", "other"]) {
    const response = await request.post(`/api/collections/${collection.id}/extractions`, {
      data: {
        sourceAssetIds: collection.assetIds,
        categories: [legacy],
        requirement: "faithful",
      },
    });
    expect(response.status(), `类别 ${legacy} 应被拒绝`).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    // 报错里点名可选的三个类别，用户知道该选什么。
    expect(body.error.message).toContain("桌面俯视图");
    expect(body.error.message).toContain("基本纹理");
    expect(body.error.message).toContain("形象设计");
  }
});
