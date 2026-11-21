import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { EXTRACTION_TERMINAL_STATUSES } from "../../src/modules/extraction/constants";
import { MOCK_SCRIPT_HINTS } from "../../src/modules/image-generation/mock-script";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 素材库、提取运行与文案版本的接口验收（docs/prd/12-asset-library.md）。
 *
 * 走真实 HTTP + 进程内 worker + mock 适配器（`GENERATION_ADAPTER=mock`）：
 * 提取与文案都由后台作业推进，用例只轮询接口等它进入终态。
 */

/** 1×1 的 PNG：类型判定只看魔数。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface LibraryAsset {
  id: string;
  category: string;
  categoryLabel: string;
  sourceAssetId: string;
  sourceAssetIndex: number | null;
  url: string;
}

interface LibraryBody {
  ok: true;
  data: { groups: Array<{ category: string; label: string; items: LibraryAsset[] }>; total: number };
}

interface ExtractionRun {
  id: string;
  status: string;
  progress: { done: number; total: number } | null;
  error: { code: string; message: string; failures: unknown[] } | null;
}

interface CopyVersion {
  id: string;
  versionNo: number;
  versionLabel: string;
  status: string;
  title: string | null;
  selectedAssetIds: string[];
  assets: Array<{ id: string; deleted: boolean; categoryLabel: string | null }>;
  error: { code: string; message: string } | null;
}

const createdCollections: string[] = [];
const createdGateways: string[] = [];

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function createCollection(
  request: APIRequestContext,
  name: string,
  imageCount: number,
): Promise<{ id: string; assetIds: string[] }> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name,
    platform: "小红书",
  };
  for (let index = 0; index < imageCount; index += 1) {
    multipart[`images-${index}`] = {
      name: `a${index}.png`,
      mimeType: "image/png",
      buffer: PNG_ONE_PIXEL,
    };
  }

  const response = await request.post("/api/collections", { multipart });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    ok: true;
    data: { id: string; assets: Array<{ id: string }> };
  };
  createdCollections.push(body.data.id);
  return { id: body.data.id, assetIds: body.data.assets.map((asset) => asset.id) };
}

/** 造一个网关并绑定对应的 Agent：`magpie-mcp` 给图片 Agent，`openai-chat` 给文案 Agent。 */
async function createGateway(
  request: APIRequestContext,
  protocol: "magpie-mcp" | "openai-chat",
  agentType: "image" | "copy",
): Promise<void> {
  const response = await request.post("/api/gateways", {
    data: {
      name: uniqueName(`e2e-lib-${agentType}`),
      protocol,
      baseUrl: "https://example.com",
      apiKey: "test-key-not-used-by-mock",
    },
  });
  expect(response.status()).toBe(201);
  const gateway = ((await response.json()) as { data: { gateway: { id: string } } }).data.gateway;
  createdGateways.push(gateway.id);

  let gatewayModelId: string | null = null;
  if (agentType === "copy") {
    const model = await request.post(`/api/gateways/${gateway.id}/models`, {
      data: { modelId: "gpt-4o-mini", capability: "text" },
    });
    expect(model.status()).toBe(201);
    gatewayModelId = "gpt-4o-mini";
  }

  const bind = await request.patch(`/api/agents/${agentType}`, {
    data: { gatewayId: gateway.id, gatewayModelId },
  });
  expect(bind.status()).toBe(200);
}

async function listLibrary(request: APIRequestContext, collectionId: string): Promise<LibraryBody["data"]> {
  const response = await request.get(`/api/collections/${collectionId}/library`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as LibraryBody).data;
}

async function listRuns(request: APIRequestContext, collectionId: string): Promise<ExtractionRun[]> {
  const response = await request.get(`/api/collections/${collectionId}/extractions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { runs: ExtractionRun[] } }).data.runs;
}

async function listVersions(
  request: APIRequestContext,
  collectionId: string,
): Promise<CopyVersion[]> {
  const response = await request.get(`/api/collections/${collectionId}/copy-versions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { versions: CopyVersion[] } }).data.versions;
}

/**
 * 等到提取运行进入**终态**（`succeeded` / `partial` / `failed`）。
 *
 * 不能只等到「不再是 queued」：worker 认领后状态先变成 running，那时素材还没入库，
 * 后续断言会读到半成品（CI 上就是这样失败的）。终态清单取自服务端常量，避免两处口径漂移。
 */
async function waitForRun(
  request: APIRequestContext,
  collectionId: string,
  runId: string,
): Promise<ExtractionRun> {
  let latest: ExtractionRun | undefined;
  await expect
    .poll(
      async () => {
        latest = (await listRuns(request, collectionId)).find((run) => run.id === runId);
        return latest !== undefined && isTerminalRun(latest.status);
      },
      { timeout: 40_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  if (!latest) throw new Error(`提取运行 ${runId} 没有出现在列表里`);
  return latest;
}

function isTerminalRun(status: string): boolean {
  return (EXTRACTION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

async function waitForVersion(
  request: APIRequestContext,
  collectionId: string,
  versionId: string,
): Promise<CopyVersion> {
  let latest: CopyVersion | undefined;
  // 等到终态（成功或失败）再断言成功：把「失败」当超时等只会给出含糊的等待超时。
  await expect
    .poll(
      async () => {
        latest = (await listVersions(request, collectionId)).find(
          (version) => version.id === versionId,
        );
        return latest?.status === "succeeded" || latest?.status === "failed";
      },
      { timeout: 40_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  if (!latest) throw new Error(`文案版本 ${versionId} 没有出现在列表里`);
  expect(latest.status, `生成失败：${latest.error?.message ?? "未知原因"}`).toBe("succeeded");
  return latest;
}

test.beforeEach(async ({ request }) => {
  await ensureAccount(request);
  // 每个用例从默认配置开始，避免上一条用例绑定的网关互相影响。
  for (const type of ["image", "copy"]) {
    const reset = await request.post(`/api/agents/${type}/reset`);
    expect(reset.status()).toBe(200);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of createdCollections.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }

  // 文案 Agent 的模型是必填项，接口不允许解绑（`AGENT_MODEL_REQUIRED`），
  // 只能直接写库还原，否则绑定的网关删不掉，而且会污染下一条用例的「默认未绑定」前提。
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      'UPDATE "agent_config" SET "gateway_id" = NULL, "gateway_model_id" = NULL',
    );
  } finally {
    await pool.end();
  }

  for (const id of createdGateways.splice(0)) {
    await request.delete(`/api/gateways/${id}`);
  }
});

test("AC-LIB-1 AC-LIB-3 2 张原图 × 2 个类别 = 进度 4；再跑一次素材增加而不是覆盖", async ({
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-1"), 2);

  const first = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: ["material", "border"],
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
  expect(library.groups.map((group) => group.category)).toEqual(["material", "border"]);
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
      categories: ["material", "border"],
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
      categories: ["material", "border"],
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
      categories: ["material"],
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
      categories: ["material", "border"],
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
      categories: ["material", "border"],
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
      categories: ["material"],
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
 * 界面验收（MKACG-939）：原始素材页签的「AI 处理」与素材库页签的分组展示
 * ------------------------------------------------------------------ */

/** 浏览器上下文与 `request` 各自持有 cookie：页面在页面上登录，接口用 ensureAccount。 */
async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

/** 界面用例的数据准备走接口：发起一次提取并等它进入终态，断言只看界面。 */
async function extractAndWait(
  request: APIRequestContext,
  collection: { id: string; assetIds: string[] },
  options: { categories?: string[]; extraPrompt?: string } = {},
): Promise<ExtractionRun> {
  const response = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: options.categories ?? ["material"],
      requirement: "faithful",
      extraPrompt: options.extraPrompt,
    },
  });
  expect(response.status()).toBe(201);
  const run = ((await response.json()) as { data: { run: ExtractionRun } }).data.run;
  return waitForRun(request, collection.id, run.id);
}

test("AC-LIB-1 AC-LIB-3 界面：2 张原图 × 2 个类别，进度 total=4，素材库 4 条；再跑一次累加", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-1-ui"), 2);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 默认页签是「原始素材」，原图默认全选。
  await expect(page.getByTestId("panel-assets")).toBeVisible();
  const sourceChecks = page.getByRole("checkbox", { name: /选择这张原图/ });
  await expect(sourceChecks).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(sourceChecks.nth(index)).toBeChecked();
  }

  // 勾选两个类别后点「AI 处理」。
  await page.getByRole("checkbox", { name: "材质纹理" }).check();
  await page.getByRole("checkbox", { name: "边框样式" }).check();
  await page.getByTestId("extract-submit").click();

  // 发起后页签顶部立刻给出进度，总数按 原图×类别 计。
  await expect(page.getByTestId("extraction-progress-text").first()).toHaveText(
    /正在提取 \d+\/4/,
  );

  // 素材库：两个类别各 2 条，每条都带来源原图缩略图。
  await page.getByTestId("tab-library").click();
  await expect(page.getByTestId("library-item")).toHaveCount(4, { timeout: 40_000 });
  await expect(
    page.getByTestId("library-group-material").getByTestId("library-item"),
  ).toHaveCount(2);
  await expect(
    page.getByTestId("library-group-border").getByTestId("library-item"),
  ).toHaveCount(2);
  await expect(page.locator("[data-testid='library-item'] img[alt^='原图 ']")).toHaveCount(4);

  // 再跑一次：素材增加而不是覆盖（AC-LIB-3）。
  await page.getByTestId("tab-assets").click();
  await page.getByRole("checkbox", { name: "材质纹理" }).check();
  await page.getByRole("checkbox", { name: "边框样式" }).check();
  await page.getByTestId("extract-submit").click();
  await page.getByTestId("tab-library").click();
  await expect(page.getByTestId("library-item")).toHaveCount(8, { timeout: 40_000 });
});

test("AC-LIB-2 界面：部分失败标注「部分失败」、失败项数量与原因，其余素材正常显示", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-2-ui"), 2);
  // mock 适配器按脚本让第 2 次调用失败：剩 3 条正常入库。
  const run = await extractAndWait(request, collection, {
    categories: ["material", "border"],
    extraPrompt: `${MOCK_SCRIPT_HINTS.failImageAt}-2`,
  });
  expect(run.status).toBe("partial");

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 运行列表：状态、失败项数量与可读原因都在这一行上。
  const runRow = page.getByTestId("extraction-run").first();
  await expect(runRow).toContainText("部分失败");
  await expect(runRow).toContainText("失败项 1 条");
  await expect(runRow).toContainText("已保留 3/4 条素材");

  // 失败项不阻断其他素材入库。
  await page.getByTestId("tab-library").click();
  await expect(page.getByTestId("library-item")).toHaveCount(3);
});

test("AC-LIB-10 原始素材页签里没有素材与文案；素材库页签里没有来源信息表单", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-LIB-10"), 1);
  await extractAndWait(request, collection, { categories: ["material", "border"] });

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 两个页签都在，默认选中的是「原始素材」。
  await expect(page.getByTestId("tab-assets")).toHaveAttribute("aria-selected", "true");
  const assetsPanel = page.getByTestId("panel-assets");
  await expect(assetsPanel).toBeVisible();
  // 提取运行与来源信息在原始素材页签；素材不在。
  await expect(assetsPanel.getByText("提取运行")).toBeVisible();
  await expect(assetsPanel.getByText("来源信息")).toBeVisible();
  await expect(assetsPanel.getByTestId("library-item")).toHaveCount(0);
  await expect(page.getByTestId("panel-library")).toHaveCount(0);

  await page.getByTestId("tab-library").click();
  const libraryPanel = page.getByTestId("panel-library");
  await expect(libraryPanel.getByTestId("library-item")).toHaveCount(2);
  // 素材库页签没有原图来源信息表单。
  await expect(libraryPanel.getByText("来源信息")).toHaveCount(0);
  await expect(libraryPanel.getByText("来源平台")).toHaveCount(0);
  await expect(libraryPanel.getByLabel("来源链接")).toHaveCount(0);
  await expect(page.getByTestId("panel-assets")).toHaveCount(0);
});

test("AC-C-8 素材库点图在站内弹窗预览，无新标签页、无 window.open", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-C-8"), 1);
  await extractAndWait(request, collection);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  await page.getByTestId("tab-library").click();
  await expect(page.getByTestId("library-item")).toHaveCount(1);

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
  await page.getByTestId("panel-library").getByTestId("image-thumbnail").first().click();
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

test("AC-U-1 375px 下两个页签不横向溢出；勾选、类别多选与删除确认可键盘操作", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-U-1"), 2);
  await extractAndWait(request, collection, { categories: ["material", "border"] });

  await loginInBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/collections/${collection.id}`);

  const viewportWidths = () =>
    page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

  let widths = await viewportWidths();
  expect(widths.scrollWidth, "原始素材页签在 375 宽度下不应横向溢出").toBe(widths.clientWidth);

  // 原图勾选：聚焦后按空格切换。
  const firstSource = page.getByRole("checkbox", { name: /选择这张原图/ }).first();
  await firstSource.focus();
  await page.keyboard.press(" ");
  await expect(firstSource).not.toBeChecked();
  await page.keyboard.press(" ");
  await expect(firstSource).toBeChecked();

  // 类别多选：聚焦后按空格切换。
  const material = page.getByRole("checkbox", { name: "材质纹理" });
  await material.focus();
  await page.keyboard.press(" ");
  await expect(material).toBeChecked();

  // 页签：左右方向键切换（ARIA 页签模式），切到素材库后同样不横向溢出。
  await page.getByTestId("tab-assets").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tab-library")).toBeFocused();
  await expect(page.getByTestId("panel-library")).toBeVisible();
  await expect(page.getByTestId("library-item")).toHaveCount(4);
  widths = await viewportWidths();
  expect(widths.scrollWidth, "素材库页签在 375 宽度下不应横向溢出").toBe(widths.clientWidth);

  // 删除确认：勾选一条素材 → 键盘打开删除按钮 → 键盘确认删除。
  const firstItemCheck = page
    .getByTestId("panel-library")
    .getByRole("checkbox", { name: /选择这条素材/ })
    .first();
  await firstItemCheck.focus();
  await page.keyboard.press(" ");
  await expect(firstItemCheck).toBeChecked();

  await page.getByTestId("library-delete").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "删除这条素材？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认删除" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("library-item")).toHaveCount(3, { timeout: 20_000 });
});
