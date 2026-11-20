import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import pg from "pg";
import { parsePublishText } from "../../src/modules/publish/text";
import { ACCOUNT, ensureAccount } from "./support/auth";

// 「复制文案」用例要读回剪贴板，浏览器必须允许读写。
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/**
 * 发布准备与发布记录的端到端验收（docs/prd/08-publish.md AC-08-1 ~ AC-08-8，
 * MKACG-867 补充的 AC-09-9、AC-09-10，以及 docs/prd/10-feature-flags.md 的 AC-10-5）。
 *
 * 结果由 HTTP 接口创建任务、进程内 worker（`GENERATION_ADAPTER=mock`）产出；用例只轮询任务详情，
 * 等它进入终态后再操作界面。每个用例自带数据准备与清理，结束后按 id 删除资源夹。
 */

const GATEWAY_NAME = "e2e 发布网关";
const IMAGE_MODEL = { modelId: "e2e-publish-image", capability: "image" };
const COPY_MODEL = { modelId: "e2e-publish-copy", capability: "text" };
const TERMINAL = new Set(["succeeded", "partial", "failed"]);

const PUBLISHED_TEXT = "分享功能不可用";

interface StageView {
  stage: string;
  status: string;
  attempts: number;
}

interface ResultAsset {
  id: string;
  fileName: string;
}

interface ResultView {
  id: string;
  taskId: string;
  title: string | null;
  body: string | null;
  tags: string[];
  assets: ResultAsset[];
}

interface TaskView {
  id: string;
  status: string;
  resultId: string | null;
  result: ResultView | null;
  stages: { image: StageView; copy: StageView };
}

interface PublishRecordView {
  id: string;
  resultId: string;
  title: string;
}

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdCollectionIds: string[] = [];

/** 用例会把两个 Agent 绑到测试网关；跑完按原值还原，避免影响后续 spec 文件。 */
interface AgentBinding {
  gatewayId: string | null;
  gatewayModelId: string | null;
  enabled: boolean;
}

const agentBindingsBefore = new Map<string, AgentBinding>();

async function readAgentBindings(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/agents");
  expect(response.status()).toBe(200);
  const agents = (
    (await response.json()) as {
      data: {
        agents: { type: string; gatewayId: string | null; gatewayModelId: string | null; enabled: boolean }[];
      };
    }
  ).data.agents;
  for (const agent of agents) {
    agentBindingsBefore.set(agent.type, {
      gatewayId: agent.gatewayId,
      gatewayModelId: agent.gatewayModelId,
      enabled: agent.enabled,
    });
  }
}

/** 接口不支持解绑，只能直接写库还原（与 results.spec.ts 同一条理由）。 */
async function restoreAgentBindings(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("还原 Agent 绑定需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    for (const [type, binding] of agentBindingsBefore) {
      await pool.query(
        'UPDATE "agent_config" SET "gateway_id" = $1, "gateway_model_id" = $2, "enabled" = $3 WHERE "type" = $4',
        [binding.gatewayId, binding.gatewayModelId, binding.enabled, type],
      );
    }
  } finally {
    await pool.end();
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function ensureGateway(request: APIRequestContext): Promise<string> {
  const listed = await request.get("/api/gateways");
  expect(listed.status()).toBe(200);
  const gateways = (
    (await listed.json()) as {
      data: { gateways: { id: string; name: string; models: { modelId: string }[] }[] };
    }
  ).data.gateways;

  const existing = gateways.find((gateway) => gateway.name === GATEWAY_NAME);
  if (existing) {
    for (const model of [IMAGE_MODEL, COPY_MODEL]) {
      if (!existing.models.some((candidate) => candidate.modelId === model.modelId)) {
        const added = await request.post(`/api/gateways/${existing.id}/models`, { data: model });
        expect(added.status()).toBe(201);
      }
    }
    return existing.id;
  }

  const created = await request.post("/api/gateways", {
    data: {
      name: GATEWAY_NAME,
      protocol: "openai-chat",
      baseUrl: "https://gw.publish-e2e.example.com/v1",
      // 用例从不发起真实请求，这个值只需满足「有密钥」。
      apiKey: "e2e-not-a-real-key",
    },
  });
  expect(created.status()).toBe(201);
  const gatewayId = ((await created.json()) as { data: { gateway: { id: string } } }).data.gateway.id;

  for (const model of [IMAGE_MODEL, COPY_MODEL]) {
    const added = await request.post(`/api/gateways/${gatewayId}/models`, { data: model });
    expect(added.status()).toBe(201);
  }
  return gatewayId;
}

async function patchAgent(
  request: APIRequestContext,
  type: "image" | "copy",
  data: Record<string, unknown>,
): Promise<void> {
  const response = await request.patch(`/api/agents/${type}`, { data });
  expect(response.status(), `更新 ${type} Agent 失败`).toBe(200);
}

/** 造一个带 n 张原图的资源夹：成品张数 = 原图张数（ADR 0008）。 */
async function createCollectionWithImage(
  request: APIRequestContext,
  count = 1,
): Promise<string> {
  const images = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `images-${index}`,
      {
        name: `${String.fromCharCode(97 + index)}.png`,
        mimeType: "image/png",
        buffer: PNG_ONE_PIXEL,
      },
    ]),
  );

  const response = await request.post("/api/collections", {
    multipart: {
      name: uniqueName("e2e-publish-collection"),
      platform: "小红书",
      sourceUrl: "https://example.com/note/publish",
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
      ...images,
    },
  });
  expect(response.status()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdCollectionIds.push(id);
  return id;
}

async function createTask(
  request: APIRequestContext,
  collectionId: string,
): Promise<TaskView> {
  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: { visualStyle: "fresh", copyStyle: "story", extraPrompt: null },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

async function getTask(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

/** 创建一条带上图片的结果，返回结果视图（含图片 id 与文件名）。 */
async function createResult(
  request: APIRequestContext,
  count = 2,
): Promise<{ collectionId: string; result: ResultView }> {
  const collectionId = await createCollectionWithImage(request, count);
  const created = await createTask(request, collectionId);

  const deadline = Date.now() + 40_000;
  let latest = await getTask(request, created.id);
  while (!TERMINAL.has(latest.status)) {
    if (Date.now() > deadline) {
      throw new Error(`任务 ${created.id} 没有在超时内进入终态，当前状态：${latest.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await getTask(request, created.id);
  }
  expect(latest.status, "用例需要一条成功的结果").toBe("succeeded");
  expect(latest.result).toBeTruthy();
  return { collectionId, result: latest.result as ResultView };
}

async function listRecords(
  request: APIRequestContext,
  collectionId?: string,
): Promise<PublishRecordView[]> {
  const url = collectionId ? `/api/publish-records?collectionId=${collectionId}` : "/api/publish-records";
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { items: PublishRecordView[] } }).data.items;
}

function resultCard(page: Page, resultId: string) {
  return page.locator(`[data-result-id="${resultId}"]`).first();
}

function publishDialog(page: Page) {
  return page.getByRole("dialog", { name: "发布准备" });
}

async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

/** 按 central directory 读出 ZIP 条目名：序号与顺序都在名字里（AC-09-10）。 */
function zipEntryNames(archive: Buffer): string[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset, "下载内容应当是 ZIP").toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    names.push(archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** 打开发布准备弹窗（结果页签上的入口）。 */
async function openPublishDialog(page: Page, collectionId: string, resultId: string) {
  await page.goto(`/collections/${collectionId}?tab=results`);
  await resultCard(page, resultId).getByTestId("publish-prepare").click();
  const dialog = publishDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async ({ request }) => {
  await ensureAccount(request);
  await readAgentBindings(request);
});

test.afterAll(async () => {
  await restoreAgentBindings();
});

test.beforeEach(async ({ request }) => {
  await ensureAccount(request);

  for (const type of ["image", "copy"] as const) {
    const reset = await request.post(`/api/agents/${type}/reset`);
    expect(reset.status()).toBe(200);
  }

  const gatewayId = await ensureGateway(request);
  await patchAgent(request, "image", { enabled: true, gatewayId, gatewayModelId: null });
  await patchAgent(request, "copy", {
    enabled: true,
    gatewayId,
    gatewayModelId: COPY_MODEL.modelId,
  });
});

test.afterEach(async ({ request }) => {
  await ensureAccount(request);
  for (const id of createdCollectionIds.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }
});

test("AC-08-1 发布准备默认全选：取消一张后下载得到只含选中图片的 ZIP", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request, 3);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  const checkboxes = dialog.getByTestId("publish-asset");
  await expect(checkboxes).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    await expect(checkboxes.nth(index)).toBeChecked();
  }

  // 取消第二张，剩下两张一起下载 → ZIP。
  await checkboxes.nth(1).uncheck();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByTestId("publish-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const path = await download.path();
  expect(path, "浏览器应当把 ZIP 下载到本地").toBeTruthy();
  const names = zipEntryNames(await readFile(path as string));
  expect(names).toHaveLength(2);
  expect(names.some((name) => name.includes(result.assets[1]!.fileName))).toBe(false);
});

test("AC-08-2 复制得到的文本是「标题 / 空行 / 正文 / 空行 / #标签」", async ({
  page,
  request,
}) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  await dialog.getByTestId("publish-title").fill("发布标题甲");
  await dialog.getByTestId("publish-body").fill("正文第一段\n\n正文第二段");
  await dialog.getByTestId("publish-tags").fill("旅行, 美食");
  await dialog.getByTestId("publish-copy").click();
  await expect(dialog.getByRole("status")).toContainText("文案已复制");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("发布标题甲\n\n正文第一段\n\n正文第二段\n\n#旅行 #美食");
});

test("AC-09-9 复制得到的文本能被解析回标题、正文与标签三段", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  await dialog.getByTestId("publish-title").fill("解析标题");
  await dialog.getByTestId("publish-body").fill("第一段\n\n第二段");
  await dialog.getByTestId("publish-tags").fill("#话题一 话题二");
  await dialog.getByTestId("publish-copy").click();
  await expect(dialog.getByRole("status")).toContainText("文案已复制");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(parsePublishText(clipboard)).toEqual({
    title: "解析标题",
    body: "第一段\n\n第二段",
    tags: ["话题一", "话题二"],
  });
});

test("AC-09-10 ZIP 内文件名按选中顺序编号，可直接排序", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request, 2);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  const checkboxes = dialog.getByTestId("publish-asset");
  // 先全不选，再按「后一张、前一张」勾选：序号必须跟着勾选顺序。
  await dialog.getByTestId("publish-select-none").click();
  await checkboxes.nth(1).check();
  await checkboxes.nth(0).check();

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByTestId("publish-download").click();
  const download = await downloadPromise;
  const path = await download.path();
  const names = zipEntryNames(await readFile(path as string));

  expect(names).toEqual([
    `01-${result.assets[1]!.fileName}`,
    `02-${result.assets[0]!.fileName}`,
  ]);
  expect([...names].sort()).toEqual(names);
});

test("AC-08-3 未标记前结果与全局页都不显示已发布", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  await page.goto(`/collections/${collectionId}?tab=results`);
  await expect(resultCard(page, result.id).getByTestId("publish-status")).toHaveText("未发布");

  await page.goto("/published");
  await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(0);
  expect(await listRecords(request)).toHaveLength(0);
});

test("AC-08-4 标记后全局页与资源夹页同时出现该记录", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  await dialog.getByTestId("publish-title").fill("发布后的标题");
  await dialog.getByTestId("publish-mark").click();
  await expect(page.getByTestId("publish-status").first()).toHaveText("已发布");

  await page.goto("/published");
  const globalItem = page.locator(`[data-result-id="${result.id}"]`);
  await expect(globalItem).toHaveCount(1);
  await expect(globalItem.getByTestId("publish-record-title")).toHaveText("发布后的标题");

  await page.goto(`/collections/${collectionId}?tab=published`);
  await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(1);
});

test("AC-08-5 同一结果再次标记不产生第二条记录", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const first = await openPublishDialog(page, collectionId, result.id);
  await first.getByTestId("publish-mark").click();
  await expect(page.getByTestId("publish-status").first()).toHaveText("已发布");
  expect(await listRecords(request, collectionId)).toHaveLength(1);

  const second = await openPublishDialog(page, collectionId, result.id);
  await second.getByTestId("publish-mark").click();
  await expect(page.getByTestId("publish-status").first()).toHaveText("已发布");

  const records = await listRecords(request, collectionId);
  expect(records).toHaveLength(1);
  expect(records[0]?.resultId).toBe(result.id);
});

test("AC-08-6 发布准备里改标题并保存，结果与发布记录的标题都更新", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  await dialog.getByTestId("publish-title").fill("准备时改过的标题");
  await dialog.getByTestId("publish-mark").click();

  // 结果卡上的标题由服务端数据刷新后显示。
  await expect(resultCard(page, result.id).getByTestId("result-title")).toHaveText(
    "准备时改过的标题",
  );

  const records = await listRecords(request, collectionId);
  expect(records).toHaveLength(1);
  expect(records[0]?.title).toBe("准备时改过的标题");

  await page.goto("/published");
  await expect(
    page.locator(`[data-result-id="${result.id}"]`).getByTestId("publish-record-title"),
  ).toHaveText("准备时改过的标题");
});

test("AC-08-7 点击分享到小红书只出现提示，不发起请求也不打开窗口", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  const apiRequests: string[] = [];
  const collect = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  };
  page.on("request", collect);

  const popupPromise = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  // 占位按钮带 `aria-disabled`：真实用户点得动，Playwright 的可操作性检查会拦，
  // 因此用 force 触发同一次 DOM 点击（提示仍由组件自己的 onClick 产生）。
  await dialog.getByRole("button", { name: "分享到小红书" }).click({ force: true });

  await expect(dialog.getByRole("status")).toHaveText(PUBLISHED_TEXT);
  expect(await popupPromise).toBeNull();
  await page.waitForTimeout(500);
  page.off("request", collect);
  expect(apiRequests).toEqual([]);

  // 点击分享不改变任何状态：仍然没有发布记录。
  expect(await listRecords(request, collectionId)).toHaveLength(0);
});

test("AC-10-5 分享功能关闭时入口是禁用态，点击只提示文案", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  const share = dialog.getByRole("button", { name: "分享到小红书" });
  await expect(share).toHaveAttribute("aria-disabled", "true");

  const apiRequests: string[] = [];
  const collect = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  };
  page.on("request", collect);
  const popupPromise = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);

  await share.click({ force: true });

  await expect(dialog.getByRole("status")).toHaveText(PUBLISHED_TEXT);
  expect(await popupPromise).toBeNull();
  page.off("request", collect);
  expect(apiRequests).toEqual([]);
});

test("AC-08-8 删除结果后其发布记录消失", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);

  const dialog = await openPublishDialog(page, collectionId, result.id);
  await dialog.getByTestId("publish-mark").click();
  await expect(page.getByTestId("publish-status").first()).toHaveText("已发布");

  // 在结果页签删除这一组结果（二次确认）。
  await resultCard(page, result.id).getByTestId("delete-result").click();
  await page.getByTestId("delete-confirm").click();
  await expect(resultCard(page, result.id)).toHaveCount(0);

  expect(await listRecords(request, collectionId)).toHaveLength(0);
  await page.goto("/published");
  await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(0);
});

/** 造一条已发布的记录：参数兜底用例需要一个「第 1 页应该看得到」的对象。 */
async function publishOne(page: Page, request: APIRequestContext): Promise<ResultView> {
  const { collectionId, result } = await createResult(request);
  await loginInBrowser(page);
  const dialog = await openPublishDialog(page, collectionId, result.id);
  await dialog.getByTestId("publish-mark").click();
  await expect(page.getByTestId("publish-status").first()).toHaveText("已发布");
  return result;
}

test("AC-FIX-1 全局页手改非法查询参数时按第 1 页、无筛选展示", async ({ page, request }) => {
  const result = await publishOne(page, request);

  // 页码不是数字：退回第 1 页，已发布的记录照常列出。
  const badPage = await page.goto("/published?page=abc");
  expect(badPage?.status()).toBe(200);
  await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(1);

  // 资源夹 id 不是 UUID：忽略这个筛选条件，记录仍然列出（既不报错也不查空）。
  const badFilter = await page.goto("/published?collectionId=not-a-uuid");
  expect(badFilter?.status()).toBe(200);
  await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(1);
});

test("AC-FIX-2 越界页码不报错：0 与负数回到第 1 页，超大页码按既有分页规则给空列表", async ({
  page,
  request,
}) => {
  const result = await publishOne(page, request);

  for (const pageNumber of ["0", "-1"]) {
    const response = await page.goto(`/published?page=${pageNumber}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(1);
  }

  const beyond = await page.goto("/published?page=99999");
  expect(beyond?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "发布记录", level: 1 })).toBeVisible();
  // 分页是原始 skip/take：跳过全部记录就是空列表，页面照常渲染空状态。
  await expect(page.locator(`[data-result-id="${result.id}"]`)).toHaveCount(0);
  await expect(page.getByText("还没有发布记录", { exact: false })).toBeVisible();
});

/** 水印提示必须同时说清三件事（AC-901-1）：图片来自上游模型、可能带模型自带的角标、发布前要自己确认。 */
const WATERMARK_MEANINGS = [
  "图片由上游模型生成",
  "可能带上游模型自带的水印或角标",
  "发布前请自行确认",
];

/** 提示不得声称水印已去掉，也不得把图片说成已校验合格（MKACG-901 MUST 2）。 */
const WATERMARK_FORBIDDEN = ["已去除", "无水印", "已校验合格"];

async function expectWatermarkNotice(notice: Locator): Promise<void> {
  await expect(notice).toBeVisible();
  for (const phrase of WATERMARK_MEANINGS) {
    await expect(notice, `提示应当说明「${phrase}」`).toContainText(phrase);
  }
  for (const forbidden of WATERMARK_FORBIDDEN) {
    await expect(notice, `提示不应出现「${forbidden}」`).not.toContainText(forbidden);
  }
}

/** AC-901-2：375×812 下整页不应出现横向滚动。 */
async function expectNoHorizontalOverflow(page: Page, scene: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${scene} 在 375×812 下不应横向溢出`).toBe(clientWidth);
}

test("AC-901-1 结果页签与发布准备各显示一处上游模型水印提示", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request, 2);
  await loginInBrowser(page);

  await page.goto(`/collections/${collectionId}?tab=results`);
  await expectWatermarkNotice(resultCard(page, result.id).getByTestId("result-watermark-notice"));

  await resultCard(page, result.id).getByTestId("publish-prepare").click();
  const dialog = publishDialog(page);
  await expect(dialog).toBeVisible();
  await expectWatermarkNotice(dialog.getByTestId("publish-watermark-notice"));
});

test("AC-901-2 375×812 下两处水印提示不产生横向溢出", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { collectionId, result } = await createResult(request, 3);
  await loginInBrowser(page);

  await page.goto(`/collections/${collectionId}?tab=results`);
  await expectWatermarkNotice(resultCard(page, result.id).getByTestId("result-watermark-notice"));
  await expectNoHorizontalOverflow(page, "结果页签");

  await resultCard(page, result.id).getByTestId("publish-prepare").click();
  const dialog = publishDialog(page);
  await expect(dialog).toBeVisible();
  await expectWatermarkNotice(dialog.getByTestId("publish-watermark-notice"));
  await expectNoHorizontalOverflow(page, "发布准备弹窗");
});

test("AC-901-3 提示与发布准备弹窗不发起任何 /api/ 请求", async ({ page, request }) => {
  const { collectionId, result } = await createResult(request, 2);
  await loginInBrowser(page);

  await page.goto(`/collections/${collectionId}?tab=results`);
  await expectWatermarkNotice(resultCard(page, result.id).getByTestId("result-watermark-notice"));
  // 缩略图本身走 /api/files/generated/...：等这次加载结束再开始计数，
  // 只统计「提示与弹窗」带来的请求（AC-901-3 断言的就是这部分为零）。
  await page.waitForLoadState("networkidle");

  const apiCalls: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.url().includes("/api/")) apiCalls.push(outgoing.url());
  });

  await resultCard(page, result.id).getByTestId("publish-prepare").click();
  const dialog = publishDialog(page);
  await expect(dialog).toBeVisible();
  await expectWatermarkNotice(dialog.getByTestId("publish-watermark-notice"));

  expect(apiCalls, "提示与发布准备弹窗不应发起任何 /api/ 请求").toEqual([]);
});
