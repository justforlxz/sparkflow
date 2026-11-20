import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

import { MOCK_SCRIPT_HINTS } from "../../src/modules/generation/stages/mock";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 全量验收链路（docs/acceptance.md 第 5 节的步骤 0 ~ 12）。
 *
 * 与前面 10 份功能 spec 的分工：那里逐条覆盖单个 AC，这里只按用户的实际顺序把整条链路走一遍，
 * 每一步产出的资源夹、任务、结果与发布记录交给下一步继续用，所以必须串行执行
 * （一个用例失败，后续用例直接跳过）。每一步的用例标题以「第 N 步」开头，与文档编号一致。
 *
 * 模型调用一律走 mock 适配器（`GENERATION_ADAPTER=mock`），失败路径用 `extraPrompt` 里的
 * `MOCK_SCRIPT_HINTS` 标记触发，不新增测试接口，也不消耗真实额度。
 *
 * 一处与文档字面不同，理由写在对应位置：
 * - 第 12 步的「重启服务」由同节点的 docker compose 验证执行（AC-F-4）：Playwright 的
 *   webServer 由测试框架持有，用例里不能重启进程。这里断言的正是重启后必须成立的两个事实：
 *   数据仍在、结构版本等于已应用迁移条数。
 */

test.describe.configure({ mode: "serial" });

// 第 8 步要读回剪贴板，浏览器必须允许读写。
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const GATEWAY_NAME = "e2e 全量验收网关";
const GATEWAY_BASE_URL = "https://gw.full-flow.example.com/v1";
/** 假密钥：用例不发起真实请求，这里只关心「有密钥」与「界面只显示掩码」两个事实。 */
const GATEWAY_KEY = "full-flow-test-key";
const IMAGE_MODEL_ID = "e2e-full-image";
const COPY_MODEL_ID = "e2e-full-text";

const TERMINAL = new Set(["succeeded", "partial", "failed"]);
const UNIMPLEMENTED_TEXT = "本版本未实现";
const SHARE_DISABLED_TEXT = "分享功能不可用";

/** 1×1 的 PNG：用例只关心「图片落盘且可读」，不关心像素。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface StageView {
  stage: string;
  status: string;
  attempts: number;
  error: { code: string; message: string } | null;
}

interface ResultView {
  id: string;
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

interface PublishRecordView {
  id: string;
  resultId: string;
  title: string;
}

interface CollectionDetail {
  id: string;
  assetCount: number;
  assets: { id: string; fileName: string }[];
}

interface AgentBinding {
  gatewayId: string | null;
  gatewayModelId: string | null;
  enabled: boolean;
}

/** 链路状态：每一步产出的 id 交给下一步，最后一步也用它核对数据是否还在。 */
interface ChainState {
  gatewayId?: string;
  collectionId?: string;
  collectionName?: string;
  firstTaskId?: string;
  firstResultId?: string;
  firstResultAssets?: { id: string; fileName: string }[];
  retriedTaskId?: string;
  regeneratedTaskId?: string;
  /** 第 5 步写进结果的文案，第 8 步复制、第 11 步发布记录都拿它比对。 */
  editedTitle?: string;
  editedBody?: string;
}

const chain: ChainState = {};
const createdCollectionIds: string[] = [];

/** 进入本文件之前两个 Agent 的绑定；`beforeAll` 记录，`afterAll` 写回。 */
const agentBindingsBefore = new Map<string, AgentBinding>();

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function png(name: string) {
  return { name, mimeType: "image/png", buffer: PNG_ONE_PIXEL };
}

/** 浏览器上下文与 `request` 各自持有 cookie：页面用页面上登录，接口用 `ensureAccount`。 */
async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function findCollectionId(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.get(`/api/collections?q=${encodeURIComponent(name)}`);
  expect(response.status()).toBe(200);
  const items = (
    (await response.json()) as { data: { items: { id: string; name: string }[] } }
  ).data.items;
  const found = items.filter((item) => item.name === name);
  expect(found, `没有找到刚建的资源夹 ${name}`).toHaveLength(1);
  return found[0]!.id;
}

async function getTask(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { task: TaskView } }).data.task;
}

async function listTasksOfCollection(
  request: APIRequestContext,
  collectionId: string,
): Promise<TaskView[]> {
  const response = await request.get("/api/tasks");
  expect(response.status()).toBe(200);
  const tasks = ((await response.json()) as { data: { tasks: TaskView[] } }).data.tasks;
  return tasks.filter((task) => task.collectionId === collectionId);
}

/** 轮询任务详情直到进入终态；worker 间隔 1.5 秒，这里留足余量。 */
async function waitForTerminal(
  request: APIRequestContext,
  taskId: string,
  expected?: TaskView["status"],
): Promise<TaskView> {
  const deadline = Date.now() + 60_000;
  let latest = await getTask(request, taskId);
  while (!TERMINAL.has(latest.status)) {
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 没有在超时内进入终态，当前状态：${latest.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await getTask(request, taskId);
  }
  if (expected) expect(latest.status, `任务 ${taskId} 的终态`).toBe(expected);
  return latest;
}

/** 等新任务出现在列表里（界面上点完按钮后，真正落库是异步的）。 */
async function waitForNewTask(
  request: APIRequestContext,
  collectionId: string,
  known: Set<string>,
): Promise<TaskView> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const tasks = await listTasksOfCollection(request, collectionId);
    const created = tasks.find((task) => !known.has(task.id));
    if (created) return created;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`资源夹 ${collectionId} 没有出现新任务`);
}

async function listRecords(
  request: APIRequestContext,
  collectionId: string,
): Promise<PublishRecordView[]> {
  const response = await request.get(`/api/publish-records?collectionId=${collectionId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { items: PublishRecordView[] } }).data.items;
}

function taskRow(page: Page, taskId: string) {
  return page.locator(`[data-task-id="${taskId}"]`);
}

function resultCard(page: Page, resultId: string) {
  return page.locator(`[data-result-id="${resultId}"]`).first();
}

async function openPublishDialog(page: Page, collectionId: string, resultId: string) {
  await page.goto(`/collections/${collectionId}?tab=results`);
  await resultCard(page, resultId).getByTestId("publish-prepare").click();
  const dialog = page.getByRole("dialog", { name: "发布准备" });
  await expect(dialog).toBeVisible();
  return dialog;
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

/** `_prisma_migrations` 里已应用（非回滚）的迁移条数，健康检查的 schemaVersion 应与它相等。 */
async function countAppliedMigrations(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("结构版本核对需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

async function readAgentBindings(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/agents");
  expect(response.status()).toBe(200);
  const agents = (
    (await response.json()) as {
      data: {
        agents: {
          type: string;
          enabled: boolean;
          gatewayId: string | null;
          gatewayModelId: string | null;
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

/** 接口不支持把 Agent 解绑，只能直接写库还原；e2e 的 global-setup 也用 pg 做同类清理。 */
async function restoreAgentBindings(): Promise<void> {
  if (agentBindingsBefore.size === 0) return;
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

test.beforeAll(async ({ request }) => {
  await ensureAccount(request);
  await readAgentBindings(request);
});

test.beforeEach(async ({ request }) => {
  await ensureAccount(request);
});

/** 清理只碰本文件自己造的数据：删资源夹（级联任务与发布记录）、还原 Agent 绑定、删网关。 */
test.afterAll(async ({ request }) => {
  await ensureAccount(request);

  for (const id of createdCollectionIds.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }

  await restoreAgentBindings();

  if (chain.gatewayId) {
    await request.delete(`/api/gateways/${chain.gatewayId}`);
  }
});

test("第 0 步 首次访问：注册第一个账号并登录进入工作台", async ({ page, request }) => {
  // 空库首次注册已经在 bootstrap 项目的 accounts.spec.ts 里发生（注册只能发生一次），
  // 这一步串联的是「已有账号 → 登录 → 进入受保护页面」。
  const me = await request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { data: { hasAnyUser: boolean; user: { email: string } } };
  expect(body.data.hasAnyUser).toBe(true);
  expect(body.data.user.email).toBe(ACCOUNT.email);

  await loginInBrowser(page);
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
});

test("第 1 步 设置页：新增网关（密钥掩码）、配置两个 Agent、查看功能开关区块", async ({
  page,
  request,
}) => {
  await loginInBrowser(page);
  await page.goto("/settings");

  // 新增网关。密钥只进不出的第一层证据是卡片只显示掩码。
  const gatewayCard = page.locator(
    `[data-testid="gateway-card"][data-gateway-name="${GATEWAY_NAME}"]`,
  );
  if ((await gatewayCard.count()) === 0) {
    await page.getByRole("button", { name: "新增网关" }).click();
    const createDialog = page.getByRole("dialog", { name: "新增网关" });
    await createDialog.getByLabel("网关名称").fill(GATEWAY_NAME);
    await createDialog.getByLabel("接口形状").selectOption("openai-chat");
    await createDialog.getByLabel("Base URL").fill(GATEWAY_BASE_URL);
    await createDialog.getByTestId("gateway-api-key").fill(GATEWAY_KEY);
    await createDialog.getByRole("button", { name: "创建网关" }).click();
    await expect(createDialog).toBeHidden();
  }

  await expect(gatewayCard).toBeVisible();
  await expect(gatewayCard.getByTestId("gateway-api-key-mask")).toContainText("••••");
  await expect(gatewayCard).not.toContainText(GATEWAY_KEY);

  // 模型清单只能在编辑态补：一个出图模型供图片 Agent 用，一个文本模型供文案 Agent 用。
  // 重跑时已经存在的模型跳过，避免重复添加报错。
  await gatewayCard.getByRole("button", { name: "编辑" }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑网关" });
  for (const model of [
    { modelId: IMAGE_MODEL_ID, capability: "image" },
    { modelId: COPY_MODEL_ID, capability: "text" },
  ]) {
    if ((await editDialog.getByText(model.modelId).count()) > 0) continue;
    await editDialog.getByLabel("模型 ID").fill(model.modelId);
    await editDialog.getByLabel("能力").selectOption(model.capability);
    await editDialog.getByRole("button", { name: "添加模型" }).click();
    await expect(editDialog.getByText(model.modelId)).toBeVisible();
  }
  await editDialog.getByRole("button", { name: "保存" }).click();
  await expect(editDialog).toBeHidden();

  // Agent 区块的网关候选是页面加载时服务端给的，新建的网关要刷新后才出现在下拉里。
  await page.reload();

  // 图片 Agent：网关选新网关，模型留空 → 使用网关默认图片模型（PRD 03 允许图片 Agent 不指定模型）。
  const imageAgent = page.locator('[data-testid="agent-card-image"]');
  await imageAgent.getByTestId("agent-gateway").selectOption({ label: GATEWAY_NAME });
  await imageAgent.getByTestId("agent-model").selectOption("");
  await imageAgent.getByRole("button", { name: "保存" }).click();
  await expect(imageAgent.getByRole("status")).toContainText("已保存");
  await expect(imageAgent.getByTestId("agent-binding-state")).toContainText(
    "使用网关默认图片模型",
  );

  // 文案 Agent 必须绑定具体模型（docs/prd/03 MUST 4），否则任务创建会被拒绝。
  const copyAgent = page.locator('[data-testid="agent-card-copy"]');
  await copyAgent.getByTestId("agent-gateway").selectOption({ label: GATEWAY_NAME });
  await copyAgent.getByTestId("agent-model").selectOption({ label: `${COPY_MODEL_ID}（文本）` });
  await copyAgent.getByRole("button", { name: "保存" }).click();
  await expect(copyAgent.getByRole("status")).toContainText("已保存");
  await expect(copyAgent.getByTestId("agent-binding-state")).toContainText(COPY_MODEL_ID);
  await expect(copyAgent.getByTestId("agent-ready-badge")).toHaveText("就绪");

  // 功能开关区块：图生图已实现（可操作、默认开启），分享仍标「本版本未实现」且不可操作。
  const featureSection = page.locator('[aria-label="功能开关"]');
  await expect(featureSection.getByTestId("feature-unimplemented")).toHaveCount(1);

  const imageToImage = featureSection.getByTestId("feature-flag-image-to-image");
  await expect(imageToImage.getByTestId("feature-unimplemented")).toHaveCount(0);
  await expect(imageToImage.getByRole("checkbox")).toBeEnabled();
  await expect(imageToImage.getByRole("checkbox")).toBeChecked();

  const share = featureSection.getByTestId("feature-flag-share-to-xiaohongshu");
  await expect(share.getByTestId("feature-unimplemented")).toHaveText(UNIMPLEMENTED_TEXT);
  await expect(share.getByRole("checkbox")).toBeDisabled();

  // 记下网关 id，供最后清理。
  const listed = await request.get("/api/gateways");
  expect(listed.status()).toBe(200);
  const gateways = ((await listed.json()) as { data: { gateways: { id: string; name: string }[] } })
    .data.gateways;
  const created = gateways.find((gateway) => gateway.name === GATEWAY_NAME);
  expect(created, "刚建的网关应当出现在列表里").toBeTruthy();
  chain.gatewayId = created!.id;
});

test("第 2 步 新建资源夹，上传 2 张图片并填写来源信息", async ({ page, request }) => {
  await loginInBrowser(page);
  await page.goto("/collections");

  const name = uniqueName("v1.0 全量验收");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();
  const dialog = page.getByRole("dialog", { name: "新建媒体资源夹" });
  await dialog.getByLabel("名称").fill(name);
  await dialog.getByLabel("来源平台").fill("小红书");
  await dialog.getByLabel("来源链接").fill("https://example.com/note/full-flow");
  await dialog.getByLabel("原始标题").fill("巷子里的咖啡店");
  await dialog.getByLabel("原始文案").fill("周末去了家巷子里的咖啡店，人均 50 元，靠窗能坐一下午。");
  await dialog.getByLabel("添加图片").setInputFiles([png("原始一.png"), png("原始二.png")]);
  await expect(dialog.getByText("待添加", { exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  const card = page.getByRole("link").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("2 张原图");

  chain.collectionName = name;
  chain.collectionId = await findCollectionId(request, name);
  createdCollectionIds.push(chain.collectionId);

  await card.click();
  await expect(page).toHaveURL(/\/collections\/[0-9a-f-]{36}$/);
  await expect(page.getByText("原图 2 张")).toBeVisible();
  await expect(page.getByAltText("原始一.png")).toBeVisible();
  await expect(page.getByAltText("原始二.png")).toBeVisible();
});

test("第 3 步 编辑资源夹：新增 1 张、移除 1 张并撤销，再保存", async ({ page }) => {
  await loginInBrowser(page);
  await page.goto(`/collections/${chain.collectionId}`);
  await expect(page.getByText("原图 2 张")).toBeVisible();

  await page.getByRole("button", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑" });

  // 新增一张：进入「待添加」，还没上传。
  await dialog.getByLabel("添加图片").setInputFiles([png("原始三.png")]);
  await expect(dialog.getByText("待添加", { exact: true })).toHaveCount(1);

  // 移除一张已有图 → 待移除；撤销后回到已保存。
  await dialog.getByRole("button", { name: "移除", exact: true }).first().click();
  await expect(dialog.getByText("待移除", { exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "撤销移除", exact: true }).click();
  await expect(dialog.getByText("待移除", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("已保存", { exact: true })).toHaveCount(2);

  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(page.getByText("原图 3 张")).toBeVisible();
  await expect(page.getByAltText("原始一.png")).toBeVisible();
  await expect(page.getByAltText("原始二.png")).toBeVisible();
  await expect(page.getByAltText("原始三.png")).toBeVisible();
});

test("第 4 步 发起创作（3 张原图 → 3 张成品），两个阶段进入终态", async ({ page, request }) => {
  await loginInBrowser(page);
  await page.goto(`/collections/${chain.collectionId}`);

  await page.getByTestId("start-creation").click();
  const dialog = page.getByRole("dialog", { name: "开始 AI 创作" });
  await dialog.getByLabel("视觉方向").selectOption("fresh");
  await dialog.getByLabel("文案风格").selectOption("story");
  // 张数不再可选：弹窗只显示「预计成品张数 = 原图张数」（ADR 0008）。
  await expect(dialog.getByTestId("expected-image-count")).toHaveText("3 张");
  await dialog.getByTestId("submit-creation").click();
  // 提交后停在资源夹详情页，创作区就地显示两个阶段（MKACG-916 AC-C-1）。
  await expect(page).toHaveURL(
    new RegExp(`/collections/${chain.collectionId}(\\?tab=assets)?(#creation)?$`),
  );

  const created = await waitForNewTask(request, chain.collectionId!, new Set());
  const task = await waitForTerminal(request, created.id, "succeeded");

  expect(task.stages.image.status).toBe("succeeded");
  expect(task.stages.copy.status).toBe("succeeded");
  expect(task.resultId).toBeTruthy();
  expect(task.result?.assets).toHaveLength(3);
  expect(task.result?.title?.length).toBeGreaterThan(0);
  expect(task.result?.body?.length).toBeGreaterThan(0);
  expect(task.result?.tags.length).toBeGreaterThan(0);

  chain.firstTaskId = task.id;
  chain.firstResultId = task.resultId!;
  chain.firstResultAssets = task.result?.assets ?? [];
});

test("第 5 步 查看任务：两个阶段状态独立可见，编辑结果的标题、正文与标签", async ({
  page,
}) => {
  await loginInBrowser(page);
  await page.goto("/tasks");

  const row = taskRow(page, chain.firstTaskId!);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("stage-image-status")).toHaveText("已完成");
  await expect(row.getByTestId("stage-copy-status")).toHaveText("已完成");

  const title = uniqueName("全量验收标题");
  const body = "这是全量验收链路上写进结果的一段正文。";

  await page.goto(`/collections/${chain.collectionId}?tab=results`);
  const card = resultCard(page, chain.firstResultId!);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("publish-status")).toHaveText("未发布");

  await card.getByTestId("edit-result").click();
  const dialog = page.getByRole("dialog", { name: "编辑结果" });
  await dialog.getByLabel("标题").fill(title);
  await dialog.getByLabel("正文").fill(body);
  await dialog.getByLabel("标签").fill("旅行，咖啡");
  await dialog.getByTestId("edit-save").click();

  await expect(card.getByTestId("result-title")).toHaveText(title);
  await expect(card.getByTestId("result-body")).toHaveText(body);
  await expect(card.getByTestId("result-tags")).toHaveText("#旅行 #咖啡");

  // 刷新后仍然是新值：改动真的落库了。
  await page.reload();
  const reloaded = resultCard(page, chain.firstResultId!);
  await expect(reloaded.getByTestId("result-title")).toHaveText(title);
  await expect(reloaded.getByTestId("result-body")).toHaveText(body);

  chain.editedTitle = title;
  chain.editedBody = body;
});

test("第 6 步 制造文案阶段失败后重试：只重跑文案阶段，图片数不变", async ({
  page,
  request,
}) => {
  await loginInBrowser(page);
  await page.goto(`/collections/${chain.collectionId}`);

  // 「补充要求」里带上 mock 的失败标记：文案阶段第一次失败，图片阶段照常成功。
  await page.getByTestId("start-creation").click();
  const dialog = page.getByRole("dialog", { name: "开始 AI 创作" });
  await expect(dialog.getByTestId("expected-image-count")).toHaveText("3 张");
  await dialog.getByLabel("补充要求").fill(MOCK_SCRIPT_HINTS.failCopyOnce);
  await dialog.getByTestId("submit-creation").click();
  // 提交后停在资源夹详情页，创作区就地显示两个阶段（MKACG-916 AC-C-1）。
  await expect(page).toHaveURL(
    new RegExp(`/collections/${chain.collectionId}(\\?tab=assets)?(#creation)?$`),
  );

  const created = await waitForNewTask(
    request,
    chain.collectionId!,
    new Set([chain.firstTaskId!]),
  );
  const partial = await waitForTerminal(request, created.id, "partial");
  expect(partial.stages.image.status).toBe("succeeded");
  expect(partial.stages.copy.status).toBe("failed");
  const assetIdsBefore = partial.result?.assets.map((asset) => asset.id) ?? [];
  expect(assetIdsBefore).toHaveLength(3);

  // 列表上两个阶段各自的状态与失败原因都可见，重试入口只在有失败阶段时出现。
  await page.goto("/tasks");
  const row = taskRow(page, created.id);
  await expect(row.getByTestId("stage-image-status")).toHaveText("已完成");
  await expect(row.getByTestId("stage-copy-status")).toHaveText("失败");
  await expect(row.getByTestId("stage-copy-error")).toContainText("文案阶段");
  await expect(row.getByTestId("retry-button")).toBeVisible();
  await row.getByTestId("retry-button").click();

  // 重试请求是异步落库的：先等文案阶段被重新排入队列（attempts 加 1），再等终态。
  // 否则第一次轮询可能还读到旧的 `partial`，被当成已经结束。
  await expect
    .poll(async () => (await getTask(request, created.id)).stages.copy.attempts, {
      timeout: 15_000,
    })
    .toBe(2);

  const finished = await waitForTerminal(request, created.id, "succeeded");
  expect(finished.stages.copy.attempts).toBe(2);
  expect(finished.stages.image.attempts).toBe(1);
  expect(finished.resultId).toBe(partial.resultId);
  expect(finished.result?.assets.map((asset) => asset.id)).toEqual(assetIdsBefore);

  chain.retriedTaskId = created.id;
});

test("第 7 步 重新生成：出现确认，确认后新增任务，旧结果仍在", async ({ page, request }) => {
  await loginInBrowser(page);
  const before = await listTasksOfCollection(request, chain.collectionId!);

  await page.goto("/tasks");
  const row = taskRow(page, chain.firstTaskId!);
  await expect(row.getByTestId("regenerate-button")).toBeVisible();
  await row.getByTestId("regenerate-button").click();

  const confirm = page.getByRole("dialog", { name: "重新生成？" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("旧任务与旧结果会保留");
  await page.getByTestId("regenerate-confirm").click();
  await expect(confirm).toBeHidden();

  const created = await waitForNewTask(
    request,
    chain.collectionId!,
    new Set(before.map((task) => task.id)),
  );
  const regenerated = await waitForTerminal(request, created.id, "succeeded");

  expect(regenerated.resultId).toBeTruthy();
  expect(regenerated.resultId).not.toBe(chain.firstResultId);

  // 旧任务与旧结果原样保留（ADR 0005：重新生成是新任务，不是覆盖）。
  const original = await getTask(request, chain.firstTaskId!);
  expect(original.resultId).toBe(chain.firstResultId);
  expect(original.result?.assets).toHaveLength(3);

  expect(await listTasksOfCollection(request, chain.collectionId!)).toHaveLength(
    before.length + 1,
  );

  chain.regeneratedTaskId = regenerated.id;
});

test("第 8 步 整理发布：取消勾选 1 张、下载 ZIP、复制文案", async ({ page }) => {
  await loginInBrowser(page);
  const dialog = await openPublishDialog(page, chain.collectionId!, chain.firstResultId!);

  // 3 张默认全选，取消第 2 张。
  const checkboxes = dialog.getByTestId("publish-asset");
  await expect(checkboxes).toHaveCount(3);
  await checkboxes.nth(1).uncheck();
  await expect(checkboxes.nth(1)).not.toBeChecked();

  // ZIP 只装选中的 2 张，条目名按选中顺序编号。
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByTestId("publish-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const archive = await readFile((await download.path()) as string);
  const kept = [0, 2].map((index) => chain.firstResultAssets![index]!.fileName);
  expect(zipEntryNames(archive)).toEqual([`01-${kept[0]}`, `02-${kept[1]}`]);

  // 复制文案：标题 / 空行 / 正文 / 空行 / #标签。
  await dialog.getByTestId("publish-title").fill("全量验收发布标题");
  await dialog.getByTestId("publish-body").fill("第一段正文\n\n第二段正文");
  await dialog.getByTestId("publish-tags").fill("旅行, 咖啡");
  await dialog.getByTestId("publish-copy").click();
  await expect(dialog.getByRole("status")).toContainText("文案已复制");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("全量验收发布标题\n\n第一段正文\n\n第二段正文\n\n#旅行 #咖啡");
});

test("第 9 步 分享到小红书：只提示「分享功能不可用」，不产生网络请求", async ({ page }) => {
  await loginInBrowser(page);
  const dialog = await openPublishDialog(page, chain.collectionId!, chain.firstResultId!);

  const apiRequests: string[] = [];
  const collect = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  };
  page.on("request", collect);

  const popup = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  const share = dialog.getByRole("button", { name: "分享到小红书" });
  await expect(share).toHaveAttribute("aria-disabled", "true");
  await share.click({ force: true });
  await expect(dialog.getByRole("status")).toContainText(SHARE_DISABLED_TEXT);
  expect(await popup, "分享入口不得打开新窗口").toBeNull();

  page.off("request", collect);
  expect(apiRequests, "分享入口不得发起接口请求").toEqual([]);
});

test("第 10 步 AC-10-4 图生图入口双向验证：开启时可用，关掉时禁用且不发请求", async ({
  page,
  request,
}) => {
  await loginInBrowser(page);

  // 开启（注册表默认）：开始创作入口是可用按钮，没有禁用态占位。
  await page.goto(`/collections/${chain.collectionId}`);
  const entry = page.getByTestId("start-creation");
  await expect(entry).toBeEnabled();
  await expect(page.getByRole("button", { name: "开始 AI 创作" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // 关掉开关：入口回到禁用态，点击只提示、不发请求。
  const off = await request.patch("/api/features/image-to-image", { data: { enabled: false } });
  expect(off.status()).toBe(200);

  try {
    await page.reload();
    const disabled = page.getByRole("button", { name: "开始 AI 创作" });
    await expect(disabled).toHaveAttribute("aria-disabled", "true");

    const apiRequests: string[] = [];
    const collect = (incoming: import("@playwright/test").Request) => {
      if (new URL(incoming.url()).pathname.startsWith("/api/")) apiRequests.push(incoming.url());
    };
    page.on("request", collect);

    await disabled.click({ force: true });
    await expect(page.getByRole("status").filter({ hasText: "该功能未启用" })).toBeVisible();
    expect(apiRequests, "关掉开关后入口不得发起接口请求").toEqual([]);

    page.off("request", collect);
  } finally {
    // 恢复默认，避免影响后续用例。
    await request.patch("/api/features/image-to-image", { data: { enabled: true } });
  }
});

test("第 11 步 标记已发布：全局与资源夹内记录一致，重复标记不新增", async ({
  page,
  request,
}) => {
  await loginInBrowser(page);
  const dialog = await openPublishDialog(page, chain.collectionId!, chain.firstResultId!);
  await dialog.getByTestId("publish-mark").click();
  // 一个资源夹下已有 3 个结果，必须按结果 id 定位到本次发布的那张卡片。
  await expect(
    resultCard(page, chain.firstResultId!).getByTestId("publish-status"),
  ).toHaveText("已发布");

  // 全局发布记录页与资源夹内的发布记录页各 1 条，标题是结果的标题快照。
  await page.goto("/published");
  const globalItem = page.locator(`[data-result-id="${chain.firstResultId}"]`);
  await expect(globalItem).toHaveCount(1);
  await expect(globalItem.getByTestId("publish-record-title")).toHaveText(chain.editedTitle!);

  await page.goto(`/collections/${chain.collectionId}?tab=published`);
  await expect(page.locator(`[data-result-id="${chain.firstResultId}"]`)).toHaveCount(1);

  const records = await listRecords(request, chain.collectionId!);
  expect(records).toHaveLength(1);
  expect(records[0]!.title).toBe(chain.editedTitle);

  // 再标记一次：返回的还是同一条记录，表里仍然只有 1 行。
  const again = await openPublishDialog(page, chain.collectionId!, chain.firstResultId!);
  await again.getByTestId("publish-mark").click();
  await expect(again).toBeHidden();

  const recordsAfter = await listRecords(request, chain.collectionId!);
  expect(recordsAfter).toHaveLength(1);
  expect(recordsAfter[0]!.id).toBe(records[0]!.id);
});

test("第 12 步 重启后数据仍在，结构版本等于已应用迁移条数", async ({ page, request }) => {
  /**
   * 「重启服务」这一步由同节点的 docker compose 验证执行（AC-F-4：`docker compose restart app`
   * 后数据完整、无卡在 `running` 的阶段）。Playwright 的 webServer 由测试框架自己拉起，
   * 用例里不能重启进程，所以这里断言重启后必须成立的两个事实。
   */
  await loginInBrowser(page);

  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  const schemaVersion = ((await health.json()) as { data: { schemaVersion: number } }).data
    .schemaVersion;
  expect(schemaVersion).toBe(await countAppliedMigrations());
  expect(schemaVersion).toBeGreaterThan(0);

  // 数据还在：3 个任务（首次创作、失败重试、重新生成）全部处于终态，没有一个卡在 running。
  const tasks = await listTasksOfCollection(request, chain.collectionId!);
  expect(tasks).toHaveLength(3);
  for (const task of tasks) {
    expect(TERMINAL.has(task.status), `任务 ${task.id} 的状态是 ${task.status}`).toBe(true);
    for (const stage of [task.stages.image, task.stages.copy]) {
      expect(stage.status, `阶段 ${stage.stage} 不应卡在执行中`).not.toBe("running");
    }
  }

  // 资源夹的原图与结果、发布记录也都还在（重启不丢数据）。
  const detail = await request.get(`/api/collections/${chain.collectionId}`);
  expect(detail.status()).toBe(200);
  const collection = ((await detail.json()) as { data: CollectionDetail }).data;
  expect(collection.assetCount).toBe(3);
  expect(collection.assets.map((asset) => asset.fileName)).toEqual([
    "原始一.png",
    "原始二.png",
    "原始三.png",
  ]);
  expect(await listRecords(request, chain.collectionId!)).toHaveLength(1);

  // 页面也能正常打开，任务列表与工作台不报错。
  await page.goto("/tasks");
  await expect(taskRow(page, chain.firstTaskId!)).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
});
