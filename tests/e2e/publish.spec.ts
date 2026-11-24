import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { MOCK_COPY_TEXT } from "../../src/modules/copy-generation/adapters/mock";
import { formatPublishText, parseTagInput } from "../../src/modules/publish/text";
import { loginInBrowser } from "./support/auth";
import {
  cleanupLibraryData,
  createCollection,
  createGateway,
  extractAndWait,
  listLibrary,
  prepareAgents,
  uniqueName,
  waitForVersion,
  type CopyVersion,
} from "./support/library";

/**
 * 「发布」页签的界面验收（docs/prd/12-asset-library.md「页面结构」第三行，
 * AC-LIB-5 ~ AC-LIB-8、AC-P-1 ~ AC-P-3）。
 *
 * 数据准备走接口（提取与文案都靠后台 worker），断言只看界面上看得见的东西：
 * 分组选素材、生成进度、当前版本与历史版本、复制格式、标记发布与发布记录。
 */

/** 版本视图里界面用到的字段（`support/library.ts` 的 `CopyVersion` 只覆盖接口断言用的部分）。 */
interface PublishCopyVersion extends CopyVersion {
  body: string | null;
  tags: string[];
  createdAt: string;
}

interface WindowWithClipboard {
  copiedText?: string | null;
}

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
});

async function libraryAssetIds(
  request: APIRequestContext,
  collectionId: string,
): Promise<string[]> {
  const library = await listLibrary(request, collectionId);
  // 与界面上的分组顺序一致：按类别分组，组内按生成时间倒序（服务端已排好）。
  return library.groups.flatMap((group) => group.items.map((item) => item.id));
}

async function listVersionDetails(
  request: APIRequestContext,
  collectionId: string,
): Promise<PublishCopyVersion[]> {
  const response = await request.get(`/api/collections/${collectionId}/copy-versions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { versions: PublishCopyVersion[] } }).data.versions;
}

/** 接口层先造一版已生成成功的文案，用于历史版本与「删掉某一版」这类准备。 */
async function createVersion(
  request: APIRequestContext,
  collectionId: string,
  assetIds: string[],
): Promise<PublishCopyVersion> {
  const response = await request.post(`/api/collections/${collectionId}/copy-versions`, {
    data: { selectedAssetIds: assetIds, copyStyle: "story" },
  });
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: { version: PublishCopyVersion } }).data.version;
  await waitForVersion(request, collectionId, created.id);
  return created;
}

/**
 * 打开一个资源夹的「发布」视图。
 *
 * MKACG-974 把资源夹详情改成三栏工作区（素材 / 结果 / 设置），页签没有了；
 * 文案与发布是下一个节点（MKACG-976）要下线的东西，在那之前用 `?view=publish` 保留入口，
 * 这几条验收在功能被删除前仍然成立。
 */
async function openPublishTab(page: Page, collectionId: string): Promise<void> {
  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?view=publish`);
  await expect(page.getByTestId("panel-publish")).toBeVisible();
}

test("AC-LIB-5 AC-P-1 界面：选 3 张素材生成 v1；再选另 2 张生成 v2，两版并存且都能打开", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-5-ui"), 2);
  await extractAndWait(request, collection, { categories: ["topdown", "texture"] });
  const assetIds = await libraryAssetIds(request, collection.id);
  expect(assetIds).toHaveLength(4);

  await openPublishTab(page, collection.id);

  const libraryPanel = page.getByTestId("panel-publish-library");
  await expect(libraryPanel.getByTestId("library-item")).toHaveCount(4);
  // AC-P-1：素材区只负责选择，没有文案三段。
  await expect(libraryPanel.getByTestId("publish-title")).toHaveCount(0);
  await expect(libraryPanel.getByTestId("publish-body")).toHaveCount(0);
  await expect(libraryPanel.getByTestId("publish-generate")).toHaveCount(0);

  const checks = libraryPanel.getByRole("checkbox", { name: /选择这条素材/ });
  for (let index = 0; index < 3; index += 1) {
    await checks.nth(index).check();
  }
  await expect(page.getByTestId("publish-selected-count")).toContainText("3");

  await page.getByTestId("publish-generate").click();
  await expect(page.getByTestId("publish-version-label")).toHaveText("v1", { timeout: 60_000 });

  const copyPanel = page.getByTestId("panel-publish-copy");
  await expect(copyPanel.getByTestId("publish-title")).toHaveValue("按脚本生成的标题");
  // AC-P-1：文案区（三段与操作）里没有素材缩略图，也没有可勾选的素材条目。
  await expect(copyPanel.locator("img")).toHaveCount(0);
  await expect(copyPanel.getByTestId("library-item")).toHaveCount(0);

  // 生成后选择被清空，再选另 2 张（第 3、4 张）。
  await expect(page.getByTestId("publish-selected-count")).toContainText("0");
  await checks.nth(2).check();
  await checks.nth(3).check();
  await page.getByTestId("publish-generate").click();
  await expect(page.getByTestId("publish-version-label")).toHaveText("v2", { timeout: 60_000 });

  // 两版的选中素材各自固化（AC-LIB-5）。
  const versions = await listVersionDetails(request, collection.id);
  expect(versions.map((version) => version.versionLabel)).toEqual(["v2", "v1"]);
  expect(versions.find((version) => version.versionLabel === "v1")?.selectedAssetIds).toEqual(
    assetIds.slice(0, 3),
  );
  expect(versions.find((version) => version.versionLabel === "v2")?.selectedAssetIds).toEqual(
    [assetIds[2], assetIds[3]],
  );

  // 历史版本列表显示版本号、生成时间、素材数量与标题首行；点开能看到完整文案与当时选的素材。
  const history = page.getByTestId("version-item");
  await expect(history).toHaveCount(1);
  await expect(history.first()).toContainText("v1");
  await expect(history.first()).toContainText("素材 3 张");
  await expect(history.first()).toContainText("按脚本生成的标题");
  await history.first().click();
  await expect(page.getByTestId("publish-version-label")).toHaveText("v1");
  await expect(copyPanel.getByTestId("publish-title")).toHaveValue("按脚本生成的标题");
  await expect(
    page.getByTestId("copy-version-assets").getByTestId("image-thumbnail"),
  ).toHaveCount(3);
  // 历史版本不可编辑：没有保存按钮。
  await expect(copyPanel.getByTestId("publish-save")).toHaveCount(0);

  await page.getByTestId("publish-back-to-current").click();
  await expect(page.getByTestId("publish-version-label")).toHaveText("v2");
});

test("AC-LIB-6 界面：删掉 v1 引用的素材后，v1 仍能打开，那张显示「已删除素材」", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-6-ui"), 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture"] });
  const assetIds = await libraryAssetIds(request, collection.id);
  await createVersion(request, collection.id, assetIds);

  const removed = await request.delete(`/api/library/${assetIds[0]}`);
  expect(removed.status()).toBe(200);

  await openPublishTab(page, collection.id);

  await expect(page.getByTestId("publish-version-label")).toHaveText("v1");
  const assets = page.getByTestId("copy-version-assets");
  await expect(assets.getByTestId("deleted-asset")).toHaveCount(1);
  await expect(assets.getByTestId("deleted-asset")).toHaveText("已删除素材");
  await expect(assets.getByTestId("image-thumbnail")).toHaveCount(1);
});

test("AC-LIB-7 界面：删掉 v2 后再次生成，界面显示 v3（编号不复用）", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-7-ui"), 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture"] });
  const assetIds = await libraryAssetIds(request, collection.id);

  await createVersion(request, collection.id, assetIds);
  const second = await createVersion(request, collection.id, assetIds);

  // 界面没有「删除版本」接口（docs/prd/12「接口」表里没有这一行）：判据是编号不复用，
  // 与集成测试同一做法，直接删掉这一行再生成。
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('DELETE FROM "copy_version" WHERE id = $1', [second.id]);
  } finally {
    await pool.end();
  }

  await openPublishTab(page, collection.id);
  await expect(page.getByTestId("publish-version-label")).toHaveText("v1");

  await page
    .getByTestId("panel-publish-library")
    .getByRole("checkbox", { name: /选择这条素材/ })
    .first()
    .check();
  await page.getByTestId("publish-generate").click();
  await expect(page.getByTestId("publish-version-label")).toHaveText("v3", { timeout: 60_000 });

  // 历史版本里只有 v1：v2 已删，v3 是当前版本，界面编号仍可追溯。
  const history = page.getByTestId("version-item");
  await expect(history).toHaveCount(1);
  await expect(history.first()).toContainText("v1");
});

test("AC-LIB-8 界面：同一版本重复标记发布，发布记录仍 1 条；全局页与资源夹页一致", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collectionName = uniqueName("AC-LIB-8-ui");
  const collection = await createCollection(request, collectionName, 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture"] });
  const assetIds = await libraryAssetIds(request, collection.id);
  await createVersion(request, collection.id, assetIds);

  await openPublishTab(page, collection.id);
  await expect(page.getByTestId("publish-version-label")).toHaveText("v1");
  await expect(page.getByTestId("publish-title")).toHaveValue("按脚本生成的标题");

  await page.getByTestId("publish-mark").click();
  const record = page.getByTestId("publish-record");
  await expect(record).toHaveCount(1);
  // 发布记录显示版本号与素材快照（素材数量）（docs/prd/12「页面结构」第 5 条）。
  await expect(record.first()).toContainText("v1");
  await expect(record.first()).toContainText("素材 2 张");
  await expect(record.first()).toContainText("按脚本生成的标题");

  // 再点一次：同一版本只更新那一条，不新增（AC-LIB-8）。
  await page.getByTestId("publish-mark").click();
  await expect(record).toHaveCount(1);

  const recordsResponse = await request.get(
    `/api/collections/${collection.id}/publish-records`,
  );
  expect(recordsResponse.status()).toBe(200);
  const records = (await recordsResponse.json()) as { data: { total: number } };
  expect(records.data.total).toBe(1);

  // 全局页与资源夹页同一份数据：从侧栏进入「发布记录」。
  // 只断言这个资源夹的那一条：全局页上还有其它用例留下的记录时，不该影响本用例的判据。
  await page.getByTestId("nav-publish").click();
  await expect(page).toHaveURL("/published");
  const globalRecord = page.getByTestId("publish-record").filter({ hasText: collectionName });
  await expect(globalRecord).toHaveCount(1);
  await expect(globalRecord.first()).toContainText("v1");
});

test("AC-P-2 界面：复制文案的文本格式为「标题 / 空行 / 正文 / 空行 / #标签」", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-P-2-ui"), 1);
  await extractAndWait(request, collection, { categories: ["topdown"] });
  const assetIds = await libraryAssetIds(request, collection.id);
  await createVersion(request, collection.id, assetIds);

  await openPublishTab(page, collection.id);
  await expect(page.getByTestId("publish-title")).toHaveValue("按脚本生成的标题");

  // 剪贴板在无头浏览器里没有系统权限：替换成记录文本的假实现，断言写入的内容。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as WindowWithClipboard).copiedText = text;
        },
      },
    });
  });

  await page.getByTestId("publish-copy").click();
  const copied = await page.evaluate(() => (window as WindowWithClipboard).copiedText ?? null);

  const title = await page.getByTestId("publish-title").inputValue();
  const body = await page.getByTestId("publish-body").inputValue();
  const tags = await page.getByTestId("publish-tags").inputValue();
  const expected = formatPublishText({ title, body, tags: parseTagInput(tags) });

  const mock = JSON.parse(MOCK_COPY_TEXT) as { title: string; body: string; tags: string[] };
  expect(copied).toBe(expected);
  expect(copied).toBe(`${mock.title}\n\n${mock.body}\n\n#mock #验收`);
});

test("AC-LIB-5 界面：当前版本文案可原地保存，刷新后是新值且版本号不变", async ({
  page,
  request,
}) => {
  await createGateway(request, "magpie-mcp", "image");
  await createGateway(request, "openai-chat", "copy");
  const collection = await createCollection(request, uniqueName("AC-LIB-5-save"), 1);
  await extractAndWait(request, collection, { categories: ["topdown"] });
  const assetIds = await libraryAssetIds(request, collection.id);
  await createVersion(request, collection.id, assetIds);

  await openPublishTab(page, collection.id);
  await expect(page.getByTestId("publish-version-label")).toHaveText("v1");
  await expect(page.getByTestId("publish-title")).toHaveValue("按脚本生成的标题");

  // 三段都改，保存；标题 / 正文 / 标签分别提交，标签按逗号拆成数组写回。
  await page.getByTestId("publish-title").fill("改过的标题");
  await page.getByTestId("publish-body").fill("改过的正文\n\n第二段");
  await page.getByTestId("publish-tags").fill("新标签, 旧标签");
  await page.getByTestId("publish-save").click();
  await expect(page.getByTestId("toast")).toContainText("文案已保存。");
  await expect(page.getByTestId("publish-title")).toHaveValue("改过的标题");

  // 刷新页面从服务端重新读：三段确实落库，版本号与版本条数不变（编辑不产生新版本）。
  await page.reload();
  await expect(page.getByTestId("publish-version-label")).toHaveText("v1");
  await expect(page.getByTestId("publish-title")).toHaveValue("改过的标题");
  await expect(page.getByTestId("publish-body")).toHaveValue("改过的正文\n\n第二段");
  await expect(page.getByTestId("publish-tags")).toHaveValue("新标签, 旧标签");
  await expect(page.getByTestId("version-item")).toHaveCount(0);

  const versions = await listVersionDetails(request, collection.id);
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({
    versionLabel: "v1",
    title: "改过的标题",
    body: "改过的正文\n\n第二段",
    tags: ["新标签", "旧标签"],
  });
});

test("AC-P-3 界面：未选素材时「生成文案」置灰并给出提示", async ({ page, request }) => {
  await createGateway(request, "magpie-mcp", "image");
  const collection = await createCollection(request, uniqueName("AC-P-3-ui"), 1);
  await extractAndWait(request, collection, { categories: ["topdown"] });

  await openPublishTab(page, collection.id);

  const generate = page.getByTestId("publish-generate");
  await expect(generate).toBeDisabled();
  await expect(page.getByTestId("publish-selected-count")).toContainText("0");
  await expect(page.getByTestId("publish-generate-hint")).toHaveText(
    "先选至少 1 张素材，再生成文案。",
  );

  await page
    .getByTestId("panel-publish-library")
    .getByRole("checkbox", { name: /选择这条素材/ })
    .first()
    .check();
  await expect(generate).toBeEnabled();
  await expect(page.getByTestId("publish-generate-hint")).toHaveCount(0);
});