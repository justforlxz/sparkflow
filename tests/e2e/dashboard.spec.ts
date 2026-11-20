import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 工作台与全局状态的端到端验收（docs/prd/09-dashboard.md AC-09-1 ~ AC-09-7，
 * 以及 MKACG-868 补充的 AC-10-8、AC-10-9）。
 *
 * 数据准备全部走接口：资源夹与任务由 HTTP 创建，结果由 mock 适配器的进程内 worker 产出。
 * AC-09-1 要求「初始状态下四个统计都是 0」，因此该用例先清空已有资源夹（连带级联删除任务、
 * 结果与发布记录），保证起点确定；其余用例都断言「操作前后的差值」，不依赖库里的历史数据。
 */

const GATEWAY_NAME = "e2e 工作台网关";
const IMAGE_MODEL = { modelId: "e2e-dashboard-image", capability: "image" };
const COPY_MODEL = { modelId: "e2e-dashboard-copy", capability: "text" };
const TERMINAL = new Set(["succeeded", "partial", "failed"]);

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface StatsView {
  collections: number;
  pendingGeneration: number;
  pendingPublish: number;
  published: number;
  recentCollections: Array<{ id: string; name: string }>;
  recentResults: Array<{ id: string; collectionId: string; title: string | null }>;
}

interface ResultView {
  id: string;
  taskId: string;
  assets: Array<{ id: string }>;
}

interface TaskView {
  id: string;
  status: string;
  resultId: string | null;
  result: ResultView | null;
}

const createdCollectionIds: string[] = [];
const createdGatewayIds: string[] = [];

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
        agents: {
          type: string;
          gatewayId: string | null;
          gatewayModelId: string | null;
          enabled: boolean;
        }[];
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

/** 接口不支持解绑，只能直接写库还原（与 publish.spec.ts 同一条理由）。 */
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

async function getStats(request: APIRequestContext): Promise<StatsView> {
  const response = await request.get("/api/stats");
  expect(response.status(), "GET /api/stats 应当返回 200").toBe(200);
  return ((await response.json()) as { data: StatsView }).data;
}

function numbers(stats: StatsView) {
  return {
    collections: stats.collections,
    pendingGeneration: stats.pendingGeneration,
    pendingPublish: stats.pendingPublish,
    published: stats.published,
  };
}

async function deleteAllCollections(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/collections?pageSize=60");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    data: { items: Array<{ id: string }>; total: number };
  };
  // 分页上限 60：删到查不出来为止，保证起点为空。
  let remaining = body.data.total;
  while (remaining > 0) {
    const page = await request.get("/api/collections?pageSize=60");
    const items = ((await page.json()) as { data: { items: Array<{ id: string }> } }).data.items;
    if (items.length === 0) break;
    for (const item of items) {
      const deleted = await request.delete(`/api/collections/${item.id}`);
      expect(deleted.status(), `删除资源夹 ${item.id} 失败`).toBe(200);
      remaining -= 1;
    }
  }
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
      baseUrl: "https://gw.dashboard-e2e.example.com/v1",
      // 用例从不发起真实请求，这个值只需满足「有密钥」。
      apiKey: "e2e-not-a-real-key",
    },
  });
  expect(created.status()).toBe(201);
  const gatewayId = ((await created.json()) as { data: { gateway: { id: string } } }).data.gateway.id;
  createdGatewayIds.push(gatewayId);

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

async function createCollectionWithImage(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/collections", {
    multipart: {
      name: uniqueName("e2e-dashboard-collection"),
      platform: "小红书",
      sourceUrl: "https://example.com/note/dashboard",
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
      extractTarget: "桌垫的织物纹理",
      "images-0": { name: "a.png", mimeType: "image/png", buffer: PNG_ONE_PIXEL },
    },
  });
  expect(response.status()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdCollectionIds.push(id);
  return id;
}

async function createTask(request: APIRequestContext, collectionId: string): Promise<TaskView> {
  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: { extractRequirement: "faithful", copyStyle: "story", extraPrompt: null },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

async function getTask(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

/** 创建一条带上图片的结果（mock worker），返回结果视图。 */
async function createResult(
  request: APIRequestContext,
): Promise<{ collectionId: string; result: ResultView }> {
  const collectionId = await createCollectionWithImage(request);
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

async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

function statTile(page: Page, key: string) {
  return page.getByTestId(`stat-${key}`);
}

/** 页面上的四项统计，读成与接口相同的形状，便于直接对比。 */
async function readStatTiles(page: Page) {
  const read = async (key: string) => Number(await statTile(page, key).innerText());
  return {
    collections: await read("collections"),
    pendingGeneration: await read("pendingGeneration"),
    pendingPublish: await read("pendingPublish"),
    published: await read("published"),
  };
}

/** 五个导航项：路径与页面标题（AC-10-8）。 */
const NAV_ROUTES = [
  { label: "工作台", href: "/", heading: "工作台" },
  { label: "媒体资源夹", href: "/collections", heading: "媒体资源夹" },
  { label: "创作任务", href: "/tasks", heading: "创作任务" },
  { label: "发布记录", href: "/published", heading: "发布记录" },
  { label: "模型与 Agent 设置", href: "/settings", heading: "设置" },
] as const;

test.beforeAll(async ({ request }) => {
  await ensureAccount(request);
  await readAgentBindings(request);
});

test.afterAll(async ({ request }) => {
  await restoreAgentBindings();
  // 还原绑定后才能删除测试网关：仍被 Agent 引用时接口会返回 409。
  for (const id of createdGatewayIds.splice(0)) {
    await request.delete(`/api/gateways/${id}`);
  }
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

test("AC-09-1 初始状态下四个统计都是 0，页面显示空状态而不是假数据", async ({
  page,
  request,
}) => {
  await deleteAllCollections(request);
  await loginInBrowser(page);

  const stats = await getStats(request);
  expect(numbers(stats)).toEqual({
    collections: 0,
    pendingGeneration: 0,
    pendingPublish: 0,
    published: 0,
  });
  expect(stats.recentCollections).toEqual([]);
  expect(stats.recentResults).toEqual([]);

  await page.goto("/");
  expect(await readStatTiles(page)).toEqual({
    collections: 0,
    pendingGeneration: 0,
    pendingPublish: 0,
    published: 0,
  });
  await expect(page.getByText("还没有媒体资源夹。先建一个，把收集到的图片和来源信息存进来。")).toBeVisible();
  await expect(page.getByText("还没有生成内容。选一个资源夹开始创作，结果会出现在这里。")).toBeVisible();
});

test("AC-09-2 新建资源夹后，媒体资源夹总数与待创作各加 1", async ({ page, request }) => {
  const before = numbers(await getStats(request));

  await createCollectionWithImage(request);

  const after = await getStats(request);
  expect(numbers(after)).toEqual({
    collections: before.collections + 1,
    pendingGeneration: before.pendingGeneration + 1,
    pendingPublish: before.pendingPublish,
    published: before.published,
  });

  await loginInBrowser(page);
  await page.goto("/");
  expect(await readStatTiles(page)).toEqual(numbers(after));
});

test("AC-09-3 产生结果后，待创作减 1、待发布加 1", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request);
  const before = numbers(await getStats(request));

  await createTask(request, collectionId);
  // 等 mock worker 把两个阶段跑完：结果出现后才影响统计口径。
  const deadline = Date.now() + 40_000;
  let resultId: string | null = null;
  while (!resultId) {
    if (Date.now() > deadline) throw new Error("任务没有在超时内产出结果");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const results = await request.get(`/api/collections/${collectionId}/results`);
    expect(results.status()).toBe(200);
    const items = ((await results.json()) as { data: { results: Array<{ id: string }> } }).data
      .results;
    resultId = items[0]?.id ?? null;
  }

  const after = await getStats(request);
  expect(numbers(after)).toEqual({
    collections: before.collections,
    pendingGeneration: before.pendingGeneration - 1,
    pendingPublish: before.pendingPublish + 1,
    published: before.published,
  });

  await loginInBrowser(page);
  await page.goto("/");
  expect(await readStatTiles(page)).toEqual(numbers(after));
});

test("AC-09-4 标记发布后，待发布减 1、已发布加 1，最近内容里出现该条目", async ({
  page,
  request,
}) => {
  const { result } = await createResult(request);
  const before = numbers(await getStats(request));

  const published = await request.post(`/api/results/${result.id}/publish`, {
    data: {
      title: "工作台验收标题",
      body: "工作台验收正文",
      tags: ["工作台"],
      selectedAssetIds: [result.assets[0].id],
    },
  });
  expect(published.status()).toBe(200);

  const after = await getStats(request);
  expect(numbers(after)).toEqual({
    collections: before.collections,
    pendingGeneration: before.pendingGeneration,
    pendingPublish: before.pendingPublish - 1,
    published: before.published + 1,
  });
  expect(after.recentResults.map((item) => item.id)).toContain(result.id);

  await loginInBrowser(page);
  await page.goto("/");
  expect(await readStatTiles(page)).toEqual(numbers(after));
  await expect(
    page.locator(`[data-testid="recent-result"][data-result-id="${result.id}"]`),
  ).toBeVisible();
});

test("AC-09-5 侧栏计数与工作台统计一致", async ({ page, request }) => {
  await createCollectionWithImage(request);

  await loginInBrowser(page);
  await page.goto("/");

  const tiles = await readStatTiles(page);
  const navCollections = Number(await page.getByTestId("nav-count-collections").innerText());
  const navTasks = Number(await page.getByTestId("nav-count-tasks").innerText());

  expect(navCollections).toBe(tiles.collections);
  expect(navTasks).toBe(tiles.pendingGeneration);
});

test("AC-09-6 点击「查看全部」与「最近的资源夹」跳转正确", async ({ page, request }) => {
  const collectionId = await createCollectionWithImage(request);
  await loginInBrowser(page);
  await page.goto("/");

  await page.getByTestId("dashboard-view-all").click();
  await expect(page).toHaveURL("/collections");

  await page.goto("/");
  await page.locator(`[data-testid="recent-collection"][data-collection-id="${collectionId}"]`).click();
  await expect(page).toHaveURL(`/collections/${collectionId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("e2e-dashboard-collection");
  await expect(page.getByText("This page could not be found")).toHaveCount(0);
});

test("AC-09-7 窄屏（375×812）下侧栏折叠，五个导航项仍可点击进入对应页面", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  await loginInBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });

  await page.goto("/");
  const collectionsLink = page.getByTestId("nav-collections");
  await expect(collectionsLink).toBeVisible();
  // 折叠后只留图标：文字标签被隐藏，链接宽度回到图标级别。
  await expect(collectionsLink.getByText("媒体资源夹")).toBeHidden();
  const box = await collectionsLink.boundingBox();
  expect(box?.width ?? 0).toBeLessThan(80);

  for (const route of NAV_ROUTES) {
    await page.getByTestId(`nav-${route.href === "/" ? "dashboard" : route.href.slice(1)}`).click();
    await expect(page).toHaveURL(route.href);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(route.heading);
    // 折叠侧栏占 64px 后，页面内容不能横向溢出。
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${route.href} 在 375 宽度下不应横向溢出`).toBeLessThanOrEqual(0);
    await page.goto("/");
  }
});

test("AC-10-8 五个导航项都能到达对应路由且不出现 404", async ({ page, request }) => {
  await ensureAccount(request);
  await loginInBrowser(page);
  await page.goto("/");

  for (const route of NAV_ROUTES) {
    const key = route.href === "/" ? "dashboard" : route.href.slice(1);
    await page.getByTestId(`nav-${key}`).click();
    await expect(page).toHaveURL(route.href);
    const response = await page.request.get(route.href);
    expect(response.status(), `${route.href} 不应是 404`).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(route.heading);
    await expect(page.getByText("This page could not be found")).toHaveCount(0);
  }
});

test("AC-10-9 页面源码中不存在硬编码颜色，状态色只来自 globals.css 的设计变量", () => {
  const roots = ["src/app", "src/components", "src/modules"];
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      // 单元测试里会写「不该出现的颜色」作为反例，不属于页面源码。
      if (/\.test\.(ts|tsx)$/.test(entry)) continue;
      const source = readFileSync(full, "utf8");
      if (/#[0-9a-fA-F]{3,8}\b/.test(source)) offenders.push(full);
    }
  };
  for (const root of roots) walk(root);

  expect(offenders, "页面源码里必须用设计变量，不写颜色字面值").toEqual([]);

  const globals = readFileSync("src/app/globals.css", "utf8");
  for (const token of [
    "--status-draft",
    "--status-generating",
    "--status-pending-publish",
    "--status-published",
  ]) {
    expect(globals).toContain(`${token}:`);
  }
});
