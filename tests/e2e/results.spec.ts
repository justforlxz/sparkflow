import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { MOCK_SCRIPT_HINTS } from "../../src/modules/generation/stages/mock";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 任务与结果界面的端到端验收（docs/prd/07-results.md AC-07-1 ~ AC-07-9，
 * 以及 MKACG-866 补充的 AC-08-10、AC-08-11）。
 *
 * 任务由 HTTP 接口写入，进程内 worker（`GENERATION_ADAPTER=mock`）执行；用例只轮询
 * `GET /api/tasks/[id]` 等它进入终态，再断言页面上的文字与可操作入口。
 * 每个用例自带数据准备与清理，结束后按 id 删除资源夹，不依赖执行顺序。
 */

const GATEWAY_NAME = "e2e 任务与结果网关";
const IMAGE_MODEL = { modelId: "e2e-image-default", capability: "image" };
const COPY_MODEL = { modelId: "e2e-text-model", capability: "text" };

const TERMINAL = new Set(["succeeded", "partial", "failed"]);
const COPY_FAILED_HINT = "文案阶段失败，可重试或手动补写";

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
  assets: { id: string; fileName: string }[];
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

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdCollectionIds: string[] = [];
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

/** 接口不支持把文案 Agent 解绑，只能直接写库还原（与 tasks.spec.ts 同一条理由）。 */
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

/** AC-07-1 需要干净的全局任务表：清掉历史遗留任务（资源夹与原始素材不动）。 */
async function clearTasks(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("清理需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query('DELETE FROM "generation_task"');
  } finally {
    await pool.end();
  }
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
      baseUrl: "https://gw.results-e2e.example.com/v1",
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
      name: uniqueName("e2e-results-collection"),
      platform: "小红书",
      sourceUrl: "https://example.com/note/1",
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
  input: { extraPrompt?: string | null } = {},
): Promise<TaskView> {
  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: {
      visualStyle: "fresh",
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

/**
 * 等重试后的文案阶段跑完。不能用 `waitForTerminal`：`partial` 本身就是终态，
 * 点完重试立刻读一次会读到重试前的状态。
 */
async function waitForRetriedCopy(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const latest = await getTask(request, taskId);
    if (latest.status === "succeeded" && latest.stages.copy.attempts === 2) return latest;
    if (Date.now() > deadline) {
      throw new Error(
        `任务 ${taskId} 重试后没有在超时内成功，当前状态：${latest.status}，文案阶段第 ${latest.stages.copy.attempts} 次`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function listTasks(request: APIRequestContext): Promise<TaskView[]> {
  const response = await request.get("/api/tasks");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { tasks: TaskView[] } }).data.tasks;
}

async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

function taskRow(page: Page, taskId: string) {
  return page.locator(`[data-task-id="${taskId}"]`);
}

function resultCard(page: Page, resultId: string) {
  return page.locator(`[data-result-id="${resultId}"]`);
}

test.beforeAll(async ({ request }) => {
  await ensureAccount(request);
  copyBindingBefore = await readCopyBinding(request);
  // AC-07-1 断言的是「一条任务都没有」时的空状态，先把遗留任务清干净。
  await clearTasks();
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

test("AC-07-1 无任务时列表显示空状态与入口，不显示假数据", async ({ page }) => {
  await loginInBrowser(page);
  await page.goto("/tasks");

  await expect(page.getByText("还没有创作任务")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看资源夹" })).toBeVisible();
  await expect(page.getByTestId("task-row")).toHaveCount(0);
});

test("AC-07-2 任务列表同时显示生图阶段与文案阶段的状态标签", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request, 2);
  const created = await createTask(request, collectionId);
  await waitForTerminal(request, created.id, "succeeded");

  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = taskRow(page, created.id);
  await expect(row).toBeVisible();
  await expect(row.getByText("生图阶段")).toBeVisible();
  await expect(row.getByText("文案阶段")).toBeVisible();
  await expect(row.getByTestId("stage-image-status")).toHaveText("已完成");
  await expect(row.getByTestId("stage-copy-status")).toHaveText("已完成");
  await expect(row.getByText("预计成品张数 2 张")).toBeVisible();
});

test("AC-07-3 对 partial 任务点重试：只有文案阶段重排，生图阶段与图片数不变", async ({
  page,
  request,
}) => {
  const collectionId = await createCollectionWithImage(request, 2);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  const partial = await waitForTerminal(request, created.id, "partial");
  const assetIdsBefore = partial.result?.assets.map((asset) => asset.id) ?? [];
  expect(assetIdsBefore).toHaveLength(2);

  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = taskRow(page, created.id);
  await expect(row.getByTestId("stage-copy-status")).toHaveText("失败");
  const retryButton = row.getByTestId("retry-button");
  await expect(retryButton).toBeVisible();

  // 重试接口的返回就是「刚点完」的即时状态：文案阶段回到排队、生图阶段与图片原样不动。
  const [retryResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/tasks/${created.id}/retry`) &&
        response.request().method() === "POST",
    ),
    retryButton.click(),
  ]);
  const retried = ((await retryResponse.json()) as { data: { task: TaskView } }).data.task;
  expect(retried.stages.copy).toMatchObject({ status: "queued", attempts: 2 });
  expect(retried.stages.image).toMatchObject({ status: "succeeded", attempts: 1 });
  expect(retried.result?.assets.map((asset) => asset.id)).toEqual(assetIdsBefore);

  const finished = await waitForTerminal(request, created.id, "succeeded");
  expect(finished.stages.copy.attempts).toBe(2);
  expect(finished.stages.image.attempts).toBe(1);
  expect(finished.result?.assets.map((asset) => asset.id)).toEqual(assetIdsBefore);
});

test("AC-07-4 重新生成先确认：取消不产生任务，确认后新增一个任务", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId);
  await waitForTerminal(request, created.id, "succeeded");
  const countBefore = (await listTasks(request)).length;

  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = taskRow(page, created.id);
  await row.getByTestId("regenerate-button").click();
  const dialog = page.getByRole("dialog", { name: "重新生成？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("将重新执行生图与文案两个阶段并产生新结果");

  await dialog.getByTestId("regenerate-cancel").click();
  await expect(dialog).not.toBeVisible();
  // 取消之后不应产生任何请求结果。
  await page.waitForTimeout(1000);
  expect((await listTasks(request)).length).toBe(countBefore);

  await row.getByTestId("regenerate-button").click();
  await page.getByTestId("regenerate-confirm").click();

  await expect.poll(async () => (await listTasks(request)).length).toBe(countBefore + 1);
  const tasks = await listTasks(request);
  const regenerated = tasks.filter((task) => task.collectionId === collectionId);
  expect(regenerated).toHaveLength(2);
  // 旧任务与旧结果保留（ADR 0005）。列表视图不带 resultId，按详情核对。
  const originalAfter = await getTask(request, created.id);
  expect(originalAfter.resultId).toBeTruthy();
  // 新任务立刻出现在列表里，两个阶段都排队/执行中。
  await expect(page.getByTestId("task-row")).toHaveCount(countBefore + 1);
});

test("AC-07-5 全部成功的任务不显示重试按钮", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId);
  await waitForTerminal(request, created.id, "succeeded");

  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = taskRow(page, created.id);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("retry-button")).toHaveCount(0);
});

test("AC-07-6 编辑结果标题后刷新页面标题保持新值，原始素材文字不变", async ({
  page,
  request,
}) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId);
  const finished = await waitForTerminal(request, created.id, "succeeded");
  const resultId = finished.resultId!;
  const newTitle = uniqueName("改过的标题");

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);

  const card = resultCard(page, resultId);
  await expect(card).toBeVisible();
  await card.getByTestId("edit-result").click();

  const dialog = page.getByRole("dialog", { name: "编辑结果" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("标题").fill(newTitle);
  await dialog.getByTestId("edit-save").click();

  await expect(card.getByTestId("result-title")).toHaveText(newTitle);

  await page.reload();
  await expect(resultCard(page, resultId).getByTestId("result-title")).toHaveText(newTitle);

  // 原始素材与任务快照都不动（docs/prd/07 MUST NOT）。
  const collection = await request.get(`/api/collections/${collectionId}`);
  expect(collection.status()).toBe(200);
  const detail = (
    (await collection.json()) as { data: { sourceBody: string; assets: { id: string }[] } }
  ).data;
  expect(detail.sourceBody).toBe("原始文案");
  expect(detail.assets).toHaveLength(1);
});

test("AC-07-6 partial 结果手动补写后在卡片上能看到新文案", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  const partial = await waitForTerminal(request, created.id, "partial");
  const resultId = partial.resultId!;
  const manualTitle = uniqueName("手动补写的标题");

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);

  const card = resultCard(page, resultId);
  await expect(card.getByTestId("copy-failed-hint")).toBeVisible();
  await expect(card.getByTestId("result-title")).toHaveCount(0);

  await card.getByTestId("edit-result").click();
  const dialog = page.getByRole("dialog", { name: "编辑结果" });
  await dialog.getByLabel("标题").fill(manualTitle);
  await dialog.getByLabel("正文").fill("手动补写的正文");
  await dialog.getByLabel("标签").fill("补写，补写，手动");
  await dialog.getByTestId("edit-save").click();

  // 写进去的文案立刻显示，失败提示作为附加说明同时保留（阶段还没重试成功）。
  await expect(card.getByTestId("result-title")).toHaveText(manualTitle);
  await expect(card.getByTestId("result-body")).toHaveText("手动补写的正文");
  await expect(card.getByTestId("result-tags")).toHaveText("#补写 #手动");
  await expect(card.getByTestId("copy-failed-hint")).toBeVisible();

  await page.reload();
  const reloaded = resultCard(page, resultId);
  await expect(reloaded.getByTestId("result-title")).toHaveText(manualTitle);
  await expect(reloaded.getByTestId("copy-failed-hint")).toBeVisible();
});

test("AC-07-7 删除某个结果后，同资源夹另一个结果与原始素材均不受影响", async ({
  page,
  request,
}) => {
  const collectionId = await createCollectionWithImage(request);
  const first = await waitForTerminal(
    request,
    (await createTask(request, collectionId)).id,
    "succeeded",
  );
  const second = await waitForTerminal(
    request,
    (await createTask(request, collectionId)).id,
    "succeeded",
  );
  const firstResultId = first.resultId!;
  const secondResultId = second.resultId!;

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);
  await expect(page.getByTestId("result-card")).toHaveCount(2);

  await resultCard(page, firstResultId).getByTestId("delete-result").click();
  const dialog = page.getByRole("dialog", { name: "删除这个结果？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("该结果的发布记录会一并删除，原始素材不受影响");
  await dialog.getByTestId("delete-confirm").click();

  await expect(resultCard(page, firstResultId)).toHaveCount(0);
  await expect(resultCard(page, secondResultId)).toBeVisible();
  await expect(resultCard(page, secondResultId).locator("img")).toHaveCount(1);

  const collection = await request.get(`/api/collections/${collectionId}`);
  expect(collection.status()).toBe(200);
  const detail = (
    (await collection.json()) as { data: { assets: { id: string }[]; sourceBody: string } }
  ).data;
  expect(detail.assets).toHaveLength(1);
  expect(detail.sourceBody).toBe("原始文案");

  const remaining = await request.get(`/api/collections/${collectionId}/results`);
  expect(remaining.status()).toBe(200);
  const results = ((await remaining.json()) as { data: { results: ResultView[] } }).data.results;
  expect(results.map((result) => result.id)).toEqual([secondResultId]);
});

test("AC-07-8 失败阶段展示可读原因，不含密钥与堆栈", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failImage,
  });
  await waitForTerminal(request, created.id, "failed");

  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = taskRow(page, created.id);
  await expect(row.getByTestId("stage-image-status")).toHaveText("失败");
  await expect(row.getByTestId("stage-image-error")).toContainText("mock：生图阶段按脚本失败");

  // 只检查用户看得见的文字：整页 HTML 里带着框架脚本，断言它会把开发模式的分块名当成密钥。
  const visible = await page.locator("main").innerText();
  expect(visible).not.toContain("Bearer");
  expect(visible).not.toContain("apiKey");
  expect(visible).not.toMatch(/\n\s+at\s/);
});

test("AC-904-1 AC-904-4 带失败阶段的任务在列表与详情都有重试说明，375 宽度不溢出", async ({
  page,
  request,
}) => {
  const collectionId = await createCollectionWithImage(request);
  const failed = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failImage,
  });
  await waitForTerminal(request, failed.id, "failed");

  // 对照：全部成功的任务没有「重试」入口，也不该出现这条说明。
  const succeeded = await waitForTerminal(
    request,
    (await createTask(request, collectionId)).id,
    "succeeded",
  );

  await loginInBrowser(page);
  await page.goto("/tasks");

  const failedRow = taskRow(page, failed.id);
  const hint = failedRow.getByTestId("retry-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("重试沿用该任务创建时的 Agent 配置");
  await expect(hint).toContainText("请用「重新生成」");
  // 说明写在卡片上，用户在点「重试」之前就能看到，不是只挂在按钮的悬停提示里。
  await expect(failedRow.getByTestId("retry-button")).toBeVisible();

  await expect(taskRow(page, succeeded.id).getByTestId("retry-hint")).toHaveCount(0);

  // 窄屏下这条说明不得把页面撑出横向滚动条。
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tasks");
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBe(widths.clientWidth);

  // 详情页的同一位置也有这条说明。
  await page.goto(`/tasks/${failed.id}`);
  await expect(page.getByTestId("retry-hint")).toContainText("重新生成");
});

test("AC-07-9 离开任务页后不再有新请求（轮询已停止）", async ({ page, request }) => {
  test.setTimeout(120_000);

  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  await waitForTerminal(request, created.id, "partial");

  await loginInBrowser(page);
  await page.goto("/tasks");
  const row = taskRow(page, created.id);
  await expect(row).toBeVisible();

  /* 轮询只在有 running 任务时启动。这里点一次真实的重试让客户端看到排队阶段，
   * 再把 `GET /api/tasks` 的响应固定成「还在跑」，这样轮询必须一直继续 ——
   * 如果离开页面没有清理定时器，接下来的 4 秒里一定还会看到新请求。 */
  let pollCount = 0;
  const runningTask = {
    ...(await getTask(request, created.id)),
    status: "running",
    statusLabel: "执行中",
  };
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    pollCount += 1;
    await route.fulfill({ json: { ok: true, data: { tasks: [runningTask] } } });
  });

  const [retryResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/tasks/${created.id}/retry`) &&
        response.request().method() === "POST",
    ),
    row.getByTestId("retry-button").click(),
  ]);
  expect(retryResponse.status()).toBe(200);

  // 第一次轮询证明定时器确实在跑（间隔 3 秒）。
  await expect.poll(() => pollCount, { timeout: 15_000 }).toBeGreaterThan(0);

  await page.goto("/collections");
  const stoppedAt = pollCount;
  await page.waitForTimeout(4000);
  expect(pollCount).toBe(stoppedAt);
});

test("AC-08-10 任务详情能看到 attempts，重试一次后失败阶段 attempts 加 1", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  await waitForTerminal(request, created.id, "partial");

  await loginInBrowser(page);
  await page.goto(`/tasks/${created.id}`);
  await expect(page.getByTestId("stage-copy-attempts")).toHaveText("1");
  await expect(page.getByTestId("stage-image-attempts")).toHaveText("1");
  // 任务已有结果（生图阶段的图片在），标题为空时也不能说「没有生成结果」。
  await expect(page.getByTestId("result-entry")).toHaveText("查看生成图片");
  await expect(page.getByTestId("no-result-hint")).toHaveCount(0);

  // 回列表点重试，完成后再看详情：只有文案阶段次数加一。
  await page.goto("/tasks");
  await taskRow(page, created.id).getByTestId("retry-button").click();
  await waitForRetriedCopy(request, created.id);

  await page.goto(`/tasks/${created.id}`);
  await expect(page.getByTestId("stage-copy-attempts")).toHaveText("2");
  await expect(page.getByTestId("stage-image-attempts")).toHaveText("1");
});

test("AC-08-11 partial 结果的文案区域显示「文案阶段失败」提示，而不是空白", async ({
  page,
  request,
}) => {
  const collectionId = await createCollectionWithImage(request, 2);
  const created = await createTask(request, collectionId, {
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  const partial = await waitForTerminal(request, created.id, "partial");
  const resultId = partial.resultId!;
  expect(partial.result?.title).toBeNull();

  await loginInBrowser(page);
  await page.goto(`/collections/${collectionId}?tab=results`);

  const card = resultCard(page, resultId);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("copy-failed-hint")).toHaveText(COPY_FAILED_HINT);
  await expect(card.getByTestId("copy-retry-button")).toBeVisible();
  await expect(card.locator("img")).toHaveCount(2);
});
