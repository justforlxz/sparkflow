import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { MOCK_SCRIPT_HINTS } from "../../src/modules/generation/stages/mock";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 资源夹详情「创作」区的端到端验收（MKACG-916，docs/prd/07-results.md
 * 「资源夹详情的「创作」区」MUST 1 ~ MUST 6，AC-C-1 ~ AC-C-6）。
 *
 * 任务走真实链路：接口写入、进程内 worker（`GENERATION_ADAPTER=mock`）执行。
 * 界面的渲染细节（两个阶段标签、「第 k/N 张」、失败原因、折叠与展开、空状态）由
 * `src/app/(app)/collections/[id]/creation-panel.test.tsx` 逐条断言；这里只覆盖
 * 「整条链路串起来之后用户看到什么」：不跳页、跑完自己出现、刷新保持、375 不溢出。
 */

const GATEWAY_NAME = "e2e 创作区网关";
const IMAGE_MODEL = { modelId: "e2e-image-default", capability: "image" };
const COPY_MODEL = { modelId: "e2e-text-model", capability: "text" };

const TERMINAL = new Set(["succeeded", "partial", "failed"]);
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface StageView {
  stage: string;
  label: string;
  status: string;
  statusLabel: string;
  attempts: number;
  error: { code: string; message: string; at: string } | null;
}

interface ResultView {
  id: string;
  taskId: string;
  title: string | null;
  body: string | null;
  tags: string[];
  assets: { id: string; fileName: string; sortOrder: number; sourceAssetId: string | null }[];
}

interface TaskView {
  id: string;
  collectionId: string;
  status: string;
  resultId: string | null;
  result: ResultView | null;
  stages: { image: StageView; copy: StageView };
}

interface AgentBinding {
  gatewayId: string | null;
  gatewayModelId: string | null;
}

const createdCollectionIds: string[] = [];
/** 进入本文件前文案 Agent 的绑定：接口不支持解绑，只能直接写库还原（与 results.spec.ts 同因）。 */
let copyBindingBefore: AgentBinding | null = null;

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function readCopyBinding(request: APIRequestContext): Promise<AgentBinding> {
  const response = await request.get("/api/agents");
  expect(response.status()).toBe(200);
  const agents = (
    (await response.json()) as {
      data: { agents: { type: string; gatewayId: string | null; gatewayModelId: string | null }[] };
    }
  ).data.agents;
  const copy = agents.find((agent) => agent.type === "copy");
  expect(copy, "缺少文案 Agent 配置").toBeDefined();
  return { gatewayId: copy!.gatewayId, gatewayModelId: copy!.gatewayModelId };
}

async function writeCopyBinding(binding: AgentBinding): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("还原 Agent 绑定需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query(
      'UPDATE "agent_config" SET "gateway_id" = $1, "gateway_model_id" = $2 WHERE "type" = $3',
      [binding.gatewayId, binding.gatewayModelId, "copy"],
    );
  } finally {
    await pool.end();
  }
}

async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function patchAgent(
  request: APIRequestContext,
  type: "image" | "copy",
  data: Record<string, unknown>,
): Promise<void> {
  const response = await request.patch(`/api/agents/${type}`, { data });
  expect(response.status(), `更新 ${type} Agent 失败`).toBe(200);
}

/** 固定复用一个网关，每条用例只补缺的模型（与 tasks.spec.ts 同一策略）。 */
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
      baseUrl: "https://gw.creation-e2e.example.com/v1",
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

/** 造一个带 n 张原图的资源夹：成品张数 = 原图张数（ADR 0008）。 */
async function createCollection(request: APIRequestContext, count = 2): Promise<string> {
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
      name: uniqueName("e2e-creation-collection"),
      platform: "小红书",
      sourceUrl: "https://example.com/note/1",
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
      extractTarget: "桌垫的织物纹理",
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
  input: { extraPrompt?: string | null } = {},
): Promise<TaskView> {
  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: {
      extractRequirement: "faithful",
      copyStyle: "story",
      extraPrompt: input.extraPrompt ?? null,
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

async function getTask(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

async function waitForTerminal(
  request: APIRequestContext,
  taskId: string,
  expected?: TaskView["status"],
): Promise<TaskView> {
  const deadline = Date.now() + 40_000;
  let latest = await getTask(request, taskId);
  while (!TERMINAL.has(latest.status)) {
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 没有在超时内进入终态，当前状态：${latest.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await getTask(request, taskId);
  }
  if (expected) expect(latest.status).toBe(expected);
  return latest;
}

/** 等重试后的文案阶段跑完（`partial` 本身就是终态，不能只看状态）。 */
async function waitForRetriedCopy(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const latest = await getTask(request, taskId);
    if (latest.status === "succeeded" && latest.stages.copy.attempts === 2) return latest;
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 重试后没有成功，当前状态：${latest.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function viewportWidths(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test.beforeAll(async ({ request }) => {
  await ensureAccount(request);
  copyBindingBefore = await readCopyBinding(request);
});

test.afterAll(async () => {
  if (copyBindingBefore) await writeCopyBinding(copyBindingBefore);
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

test("AC-C-1 AC-C-2 发起创作后留在详情页，跑完自动出现折叠结果", async ({ page, request }) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 2);
  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);

  // 没有任务也没有结果时是引导态，不是空白（MUST 6）。
  await expect(page.getByText("这个资源夹还没有开始 AI 创作。")).toBeVisible();

  await page.getByTestId("start-creation").click();
  const dialog = page.getByRole("dialog", { name: "开始 AI 创作" });
  await dialog.getByTestId("submit-creation").click();

  // 不再跳 /tasks（AC-C-1）：提交后仍停在资源夹详情页的创作区。
  await expect(page).toHaveURL(new RegExp(`/collections/${collectionId}\\?tab=results(#creation)?$`));

  // 创作区立刻能看到这次任务（可能还在跑，也可能已经跑完）。
  const runningCard = page.getByTestId("creation-running-task");
  const result = page.getByTestId("result-card");
  await expect(runningCard.or(result).first()).toBeVisible({ timeout: 30_000 });

  // 跑完后不需要手动刷新，结果自己出现在创作区（轮询到终态后刷新服务端数据）。
  await expect(result).toHaveCount(1, { timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`/collections/${collectionId}\\?tab=results(#creation)?$`));

  // 默认折叠：只有缩略图与一行摘要，文案与按钮都不出现（AC-C-2）。
  await expect(result.getByTestId("result-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(result.locator("img")).toHaveCount(2);
  await expect(result.getByTestId("result-source").first()).toHaveText("原图 1");
  await expect(result.getByTestId("result-title")).toHaveCount(0);
  await expect(result.getByTestId("result-body")).toHaveCount(0);
  await expect(result.getByTestId("edit-result")).toHaveCount(0);
  await expect(result.getByTestId("publish-prepare")).toHaveCount(0);

  const summary = result.getByTestId("result-toggle");
  await expect(summary).toContainText("生成于");
  await expect(summary).toContainText("2 张");
  await expect(summary).toContainText("未发布");
});

test("AC-C-2 AC-C-3 展开后才出现文案与按钮，折叠状态刷新后保持", async ({ page, request }) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 2);
  const created = await createTask(request, collectionId);
  await waitForTerminal(request, created.id, "succeeded");

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);

  const result = page.getByTestId("result-card");
  await expect(result).toHaveCount(1);
  const toggle = result.getByTestId("result-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(result.getByTestId("result-title")).toHaveCount(0);
  // 水印提示也按折叠规则换：折叠态只露短文案（docs/prd/05 定稿、docs/prd/07 折叠规则）。
  await expect(result.getByTestId("result-watermark-short-notice")).toHaveText(
    "该模型可能自带水印，发布前请确认。",
  );
  await expect(result.getByTestId("result-watermark-notice")).toHaveCount(0);

  // 键盘操作：焦点落在展开按钮上，回车展开（AC-C-6 的可键盘操作部分）。
  await toggle.focus();
  await page.keyboard.press("Enter");

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(result.getByTestId("result-title")).toHaveText("按脚本生成的标题");
  await expect(result.getByTestId("result-body")).toContainText("mock 阶段处理器");
  await expect(result.getByTestId("result-tags")).toContainText("#mock");
  await expect(result.getByTestId("edit-result")).toBeVisible();
  await expect(result.getByTestId("publish-prepare")).toBeVisible();

  // 展开后换成定稿主文案，短文案让位（两段都在 PUBLISH_COPY 里）。
  await expect(result.getByTestId("result-watermark-notice")).toContainText(
    "图片由你在设置里选择的图片模型生成",
  );
  await expect(result.getByTestId("result-watermark-short-notice")).toHaveCount(0);

  // 刷新后保持展开（同一浏览器，本地存储）。
  await page.reload();
  await expect(result.getByTestId("result-title")).toHaveText("按脚本生成的标题");
  await expect(result.getByTestId("result-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  // 收起后刷新也保持收起。
  await result.getByTestId("result-toggle").click();
  await expect(result.getByTestId("result-title")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("result-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("AC-C-4 失败的阶段在创作区就地显示原因与「重试」，重试只重跑失败阶段", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 1);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  const partial = await waitForTerminal(request, created.id, "partial");
  expect(partial.stages.copy.status).toBe("failed");
  expect(partial.stages.image.attempts).toBe(1);

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);

  const troubled = page.getByTestId("creation-troubled-task");
  await expect(troubled).toBeVisible();
  await expect(troubled.getByTestId("creation-stage-copy-error")).toContainText(
    "mock：文案阶段按脚本失败",
  );
  await expect(troubled.getByTestId("creation-retry-button")).toBeVisible();

  await troubled.getByTestId("creation-retry-button").click();
  const retried = await waitForRetriedCopy(request, created.id);

  // 只重跑失败阶段：文案阶段第 2 次，生图阶段仍第 1 次，图片张数不变。
  expect(retried.stages.copy.attempts).toBe(2);
  expect(retried.stages.image.attempts).toBe(1);
  expect(retried.result?.assets).toHaveLength(1);

  // 重试成功后失败块消失，结果留在创作区（重试后轮询到终态会刷新服务端数据）。
  await expect(page.getByTestId("creation-troubled-task")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("result-card")).toHaveCount(1);
});

test("AC-C-5 从 /tasks 点「查看结果」跳到资源夹，直接看到该结果（折叠态）", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 2);
  const created = await createTask(request, collectionId);
  const done = await waitForTerminal(request, created.id, "succeeded");

  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = page.locator(`[data-task-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "查看结果" }).click();

  await expect(page).toHaveURL(new RegExp(`/collections/${collectionId}\\?tab=results#creation`));

  const result = page.locator(`[data-result-id="${done.resultId}"]`);
  await expect(result).toBeVisible();
  await expect(result.getByTestId("result-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(result.getByTestId("result-title")).toHaveCount(0);
  await expect(result.locator("img")).toHaveCount(2);
});

test("AC-C-6 375px 与 320px 下创作区不横向溢出，展开与收起可键盘操作", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 2);
  const created = await createTask(request, collectionId);
  await waitForTerminal(request, created.id, "succeeded");

  await loginInBrowser(page);

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/collections/${collectionId}?tab=results`);

    const card = page.getByTestId("result-card");
    await expect(card).toHaveCount(1);

    const toggle = card.getByTestId("result-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const collapsed = await viewportWidths(page);
    expect(collapsed.scrollWidth, `${viewport.width} 宽度下创作区不应横向溢出`).toBe(
      collapsed.clientWidth,
    );

    // 展开后内容更多，仍不应横向溢出；展开与收起都能用键盘完成。
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card.getByTestId("result-title")).toBeVisible();

    const expanded = await viewportWidths(page);
    expect(expanded.scrollWidth, `${viewport.width} 宽度下展开后仍不应横向溢出`).toBe(
      expanded.clientWidth,
    );

    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
});

test("AC-C-7 原始素材页签只有原图与来源信息，进度与结果都在「AI 创作结果」页签", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 2);
  const created = await createTask(request, collectionId);
  await waitForTerminal(request, created.id, "succeeded");

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}`);

  // 原始素材：只有原图网格与来源信息。
  await expect(page.getByTestId("image-thumbnail")).toHaveCount(2);
  await expect(page.getByRole("term").filter({ hasText: "来源平台" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "原始文案" })).toBeVisible();

  // 进度、失败任务、结果卡片一个都不在这里（MKACG-933 范围 3）。
  await expect(page.getByTestId("creation-running-task")).toHaveCount(0);
  await expect(page.getByTestId("creation-troubled-task")).toHaveCount(0);
  await expect(page.getByTestId("result-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "正在创作" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "创作结果" })).toHaveCount(0);

  // 「AI 创作结果」页签里才有结果。
  await page.goto(`/collections/${collectionId}?tab=results`);
  await expect(page.getByTestId("result-card")).toHaveCount(1);
});

test("AC-C-8 AC-C-9 AC-C-10 图片在站内弹窗看原图，键盘可达，关闭后焦点回到缩略图", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const collectionId = await createCollection(request, 1);
  const created = await createTask(request, collectionId);
  const done = await waitForTerminal(request, created.id, "succeeded");
  expect(done.resultId).toBeTruthy();

  await loginInBrowser(page);
  // 统计 window.open：任何图片点击都不该开新窗口（AC-C-8）。
  await page.addInitScript(() => {
    const state = window as unknown as { __openCount?: number };
    state.__openCount = 0;
    const open = window.open.bind(window);
    window.open = (...args: Parameters<typeof window.open>) => {
      state.__openCount = (state.__openCount ?? 0) + 1;
      return open(...args);
    };
  });
  const openCount = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __openCount?: number }).__openCount ?? 0);

  // 原始素材：缩略图是按钮，点开在站内弹窗加载原图并显示文件名（AC-C-9）。
  await page.goto(`/collections/${collectionId}`);
  const assetThumb = page.getByTestId("image-thumbnail").first();
  await expect(assetThumb).toHaveJSProperty("tagName", "BUTTON");
  expect(await assetThumb.locator("img").getAttribute("src")).toContain("?w=");

  await assetThumb.click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(page.getByTestId("image-lightbox-filename")).toHaveText("a.png");
  const assetSrc = await page.getByTestId("image-lightbox-image").getAttribute("src");
  expect(assetSrc).toContain(`/api/files/${collectionId}/`);
  expect(assetSrc).not.toContain("?w=");

  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(assetThumb).toBeFocused();

  // 整个页面没有 target="_blank" 的图片链接，也没有开过新窗口（AC-C-8）。
  expect(await page.locator('a[target="_blank"] img').count()).toBe(0);
  expect(await openCount()).toBe(0);

  // 提取图缩略图同样：Tab 聚焦、Enter 打开、关闭后焦点回来（AC-C-10）。
  await page.goto(`/collections/${collectionId}?tab=results`);
  const resultThumb = page
    .getByTestId("result-card")
    .first()
    .getByTestId("image-thumbnail")
    .first();
  await resultThumb.focus();
  await expect(resultThumb).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("image-lightbox")).toBeVisible();
  const generatedSrc = await page.getByTestId("image-lightbox-image").getAttribute("src");
  expect(generatedSrc).toContain(`/api/files/generated/${done.resultId}/`);
  expect(generatedSrc).not.toContain("?w=");

  await page.getByTestId("image-lightbox-close").click();
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
  await expect(resultThumb).toBeFocused();
  expect(await openCount()).toBe(0);
});
