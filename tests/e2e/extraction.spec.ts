import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 图片阶段改为「提取目标」之后的界面全链路（MKACG-930 AC-EX-6）：
 *
 * 资源夹新建/编辑表单 → 资源夹详情 → 创作任务弹窗 → 结果摘要，四处都直接断言可见文本，
 * 不靠「同上一处」的转述。提取目标在服务端也要拦（AC-01-9 由 collections.spec.ts 覆盖）。
 *
 * 任务由 HTTP 接口之外的界面发起，进程内 worker（`GENERATION_ADAPTER=mock`）执行；
 * 用例只轮询 `GET /api/tasks/[id]` 等它进入终态，再回到页面上断言结果摘要。
 */

const GATEWAY_NAME = "e2e 提取目标网关";
const IMAGE_MODEL = { modelId: "e2e-extract-image", capability: "image" };
const COPY_MODEL = { modelId: "e2e-extract-text", capability: "text" };
const EXTRACT_TARGET = "桌垫的织物纹理";
const TERMINAL = new Set(["succeeded", "partial", "failed"]);

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface TaskView {
  id: string;
  collectionId: string;
  status: string;
}

interface AgentBinding {
  gatewayId: string | null;
  gatewayModelId: string | null;
  enabled: boolean;
}

const createdCollectionIds: string[] = [];
/** 本次改绑定之前的两个 Agent 配置：用例结束后原样写回，避免污染其它用例。 */
let bindingsBefore: Record<"image" | "copy", AgentBinding> | null = null;

async function readBindings(
  request: APIRequestContext,
): Promise<Record<"image" | "copy", AgentBinding>> {
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

  const pick = (type: "image" | "copy"): AgentBinding => {
    const agent = agents.find((candidate) => candidate.type === type);
    expect(agent, `缺少 ${type} Agent 配置`).toBeDefined();
    return {
      enabled: agent!.enabled,
      gatewayId: agent!.gatewayId,
      gatewayModelId: agent!.gatewayModelId,
    };
  };
  return { image: pick("image"), copy: pick("copy") };
}

/** 接口不允许把必填模型的 Agent 解绑，只能直接写库还原（与 results.spec.ts 同一条理由）。 */
async function restoreBindings(bindings: Record<"image" | "copy", AgentBinding>): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("还原 Agent 绑定需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    for (const type of ["image", "copy"] as const) {
      await pool.query(
        'UPDATE "agent_config" SET "enabled" = $1, "gateway_id" = $2, "gateway_model_id" = $3 WHERE "type" = $4',
        [bindings[type].enabled, bindings[type].gatewayId, bindings[type].gatewayModelId, type],
      );
    }
  } finally {
    await pool.end();
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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

/** 一个复用的网关：用例不发起真实请求，只要求两个 Agent 就绪。 */
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
      baseUrl: "https://gw.extraction-e2e.example.com/v1",
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

async function prepareReadyAgents(request: APIRequestContext): Promise<void> {
  const gatewayId = await ensureGateway(request);
  await patchAgent(request, "image", {
    enabled: true,
    gatewayId,
    gatewayModelId: IMAGE_MODEL.modelId,
  });
  await patchAgent(request, "copy", {
    enabled: true,
    gatewayId,
    gatewayModelId: COPY_MODEL.modelId,
  });
}

async function findTaskId(request: APIRequestContext, collectionId: string): Promise<string> {
  const response = await request.get("/api/tasks");
  expect(response.status()).toBe(200);
  const tasks = ((await response.json()) as { data: { tasks: TaskView[] } }).data.tasks;
  const task = tasks.find((candidate) => candidate.collectionId === collectionId);
  expect(task, "界面上发起的任务没有出现在任务列表里").toBeDefined();
  return task!.id;
}

async function waitForTerminal(request: APIRequestContext, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const response = await request.get(`/api/tasks/${taskId}`);
    expect(response.status()).toBe(200);
    const task = ((await response.json()) as { data: { task: TaskView } }).data.task;
    if (TERMINAL.has(task.status)) return task;
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 没有在超时内进入终态，当前状态：${task.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test.afterAll(async ({ request }) => {
  await ensureAccount(request);
  if (bindingsBefore) {
    await restoreBindings(bindingsBefore);
    bindingsBefore = null;
  }
  for (const id of createdCollectionIds.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }
});

/**
 * AC-EX-6：资源夹新建表单（必填提示与示例）、资源夹详情（提取目标原文）、
 * 创作任务弹窗（只读提取目标 + 提取要求三项，且不再出现「视觉方向」）、
 * 结果摘要（提取目标来自任务快照）。
 */
test("AC-EX-6 资源夹表单 → 详情 → 创作弹窗 → 结果摘要，四处都能看到提取目标", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  bindingsBefore = await readBindings(request);
  await prepareReadyAgents(request);
  await loginInBrowser(page);

  const name = uniqueName("AC-EX-6");

  // 一、资源夹新建表单：必填提示与示例文案可见，空值时不能提交。
  await page.goto("/collections");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建媒体资源夹" });
  await expect(createDialog.getByLabel("提取目标")).toBeVisible();
  await expect(
    createDialog.getByPlaceholder("例如：桌垫的织物纹理"),
  ).toBeVisible();
  await expect(createDialog.getByText("必填：写清要从这批素材里取出什么")).toBeVisible();

  await createDialog.getByLabel("名称").fill(name);
  await createDialog.getByRole("button", { name: "保存" }).click();
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole("alert")).toHaveText("请填写提取目标");

  // 填上之后可以保存。
  await createDialog.getByLabel("提取目标").fill(EXTRACT_TARGET);
  await createDialog
    .getByLabel("添加图片")
    .setInputFiles({ name: "desk.png", mimeType: "image/png", buffer: PNG_ONE_PIXEL });
  await createDialog.getByRole("button", { name: "保存" }).click();
  await expect(createDialog).toBeHidden();

  const found = await request.get(`/api/collections?q=${encodeURIComponent(name)}`);
  expect(found.status()).toBe(200);
  const collectionId = (
    (await found.json()) as { data: { items: { id: string }[] } }
  ).data.items[0]!.id;
  createdCollectionIds.push(collectionId);

  // 二、资源夹详情：提取目标原文直接可见（不是折叠后才出现的隐藏字段）。
  await page.goto(`/collections/${collectionId}`);
  await expect(page.getByText("提取目标", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("definition").filter({ hasText: EXTRACT_TARGET }),
  ).toBeVisible();

  // 编辑表单里回填同一个值（同一个组件，但仍是一条独立的可见断言）。
  await page.getByRole("button", { name: "编辑" }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑" });
  await expect(editDialog.getByLabel("提取目标")).toHaveValue(EXTRACT_TARGET);
  await editDialog.getByRole("button", { name: "取消" }).click();

  // 三、创作任务弹窗：只读显示提取目标 + 提取要求三项，旧的「视觉方向」字样已消失。
  await page.getByTestId("start-creation").click();
  const creationDialog = page.getByRole("dialog", { name: "开始 AI 创作" });
  await expect(creationDialog.getByTestId("creation-extract-target")).toHaveText(EXTRACT_TARGET);
  const requirement = creationDialog.getByLabel("提取要求");
  await expect(requirement).toBeVisible();
  await expect(requirement.locator("option")).toHaveText(["忠实还原", "平整化", "去反光"]);
  await expect(creationDialog.getByText("视觉方向")).toHaveCount(0);

  await requirement.selectOption("faithful");
  await creationDialog.getByLabel("文案风格").selectOption("story");
  await creationDialog.getByTestId("submit-creation").click();
  // 弹窗关闭说明创建请求已经成功返回：之后再去任务列表取 id，避免读到还没落库的请求。
  await expect(creationDialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/collections/${collectionId}\\?tab=results#creation`));

  // 四、结果摘要：任务跑完后回到资源夹详情，折叠摘要里显示本次的提取目标。
  const taskId = await findTaskId(request, collectionId);
  const task = await waitForTerminal(request, taskId);
  expect(task.status).toBe("succeeded");

  await page.goto(`/collections/${collectionId}?tab=results#creation`);
  const summary = page.getByTestId("result-extract-target").first();
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText(`提取目标：${EXTRACT_TARGET}`);

  // 结果卡片的图片措辞是「提取图」，不再是「成品图」。
  await page.goto(`/collections/${collectionId}?tab=results`);
  const card = page.getByTestId("result-card").first();
  await expect(card.getByTestId("result-extract-target")).toHaveText(
    `提取目标：${EXTRACT_TARGET}`,
  );
  await expect(card.getByText("提取图 1 张")).toBeVisible();
  await expect(card.getByText("成品图")).toHaveCount(0);
});
