import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { MOCK_SCRIPT_HINTS } from "../../src/modules/generation/stages/mock";
import { ensureAccount } from "./support/auth";

/**
 * 创作任务编排的端到端验收（docs/prd/04-generation-task.md AC-04-1 ~ AC-04-9、
 * MKACG-863 补充的 AC-05-12，以及 PL 定论要求在本节点验收的 AC-03-8）。
 *
 * 执行链路是真的：任务由 HTTP 接口写入，进程内 worker（`GENERATION_ADAPTER=mock`）
 * 轮询执行，用例只轮询 `GET /api/tasks/[id]` 等它进入终态。
 *
 * 文案 Agent 必须绑定具体模型（docs/prd/03 MUST 4），而接口不允许把它改回未绑定，所以：
 * - 固定复用一个名为 `e2e 任务编排网关` 的网关，每条用例只补缺的模型，不删除它；
 * - 整个文件跑完后把文案 Agent 的绑定还原成进入本文件之前的样子（走数据库，因为接口不支持解绑）。
 *   否则下次运行 `agents.spec.ts` 的 AC-03-4 会看到文案 Agent 已绑定而失败。
 */

const GATEWAY_NAME = "e2e 任务编排网关";
const IMAGE_MODEL = { modelId: "e2e-image-default", capability: "image" };
const COPY_MODEL = { modelId: "e2e-text-model", capability: "text" };

const TERMINAL = new Set(["succeeded", "partial", "failed"]);

interface StageView {
  stage: string;
  label: string;
  status: string;
  statusLabel: string;
  attempts: number;
  error: { code: string; message: string; at: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface ResultView {
  id: string;
  title: string | null;
  body: string | null;
  tags: string[];
  visualStyle: string;
  createdAt: string;
  assets: { id: string; fileName: string; mimeType: string; sortOrder: number }[];
}

interface TaskView {
  id: string;
  collectionId: string;
  status: string;
  statusLabel: string;
  visualStyle: string;
  copyStyle: string;
  imageCount: number;
  extraPrompt: string | null;
  createdAt: string;
  stages: { image: StageView; copy: StageView };
  agents?: { image: { systemPrompt: string }; copy: { systemPrompt: string } };
  resultId: string | null;
  result: ResultView | null;
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; details?: { code?: string; taskStatus?: string } };
}

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdCollectionIds: string[] = [];

interface AgentBinding {
  gatewayId: string | null;
  gatewayModelId: string | null;
}

/** 进入本文件之前文案 Agent 的绑定；`beforeAll` 记录，`afterAll` 写回。 */
let copyBindingBefore: AgentBinding | null = null;

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

/** 接口不支持把文案 Agent 解绑，只能直接写库还原；e2e 的 global-setup 也用 pg 做同类清理。 */
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

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function patchAgent(
  request: APIRequestContext,
  type: "image" | "copy",
  data: Record<string, unknown>,
): Promise<void> {
  const response = await request.patch(`/api/agents/${type}`, { data });
  expect(response.status(), `更新 ${type} Agent 失败`).toBe(200);
}

/** 固定网关：存在就补缺模型，不存在才新建；用例之间共用一个，避免每次运行都堆一行配置。 */
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
      baseUrl: "https://gw.tasks-e2e.example.com/v1",
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

async function createCollectionWithImage(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/collections", {
    multipart: {
      name: uniqueName("e2e-task-collection"),
      platform: "小红书",
      sourceUrl: "https://example.com/note/1",
      sourceTitle: "原始标题",
      sourceBody: "原始文案",
      "images-0": { name: "a.png", mimeType: "image/png", buffer: PNG_ONE_PIXEL },
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
  input: { imageCount?: number; extraPrompt?: string | null } = {},
): Promise<TaskView> {
  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: {
      visualStyle: "fresh",
      copyStyle: "story",
      imageCount: input.imageCount ?? 2,
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

/** 轮询到终态；worker 间隔 1.5 秒，这里留足余量。 */
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

async function listTasksOfCollection(
  request: APIRequestContext,
  collectionId: string,
): Promise<TaskView[]> {
  const response = await request.get("/api/tasks");
  expect(response.status()).toBe(200);
  const tasks = ((await response.json()) as { data: { tasks: TaskView[] } }).data.tasks;
  return tasks.filter((task) => task.collectionId === collectionId);
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

test("AC-04-1 创建任务立即返回（< 1s），两阶段初始状态为 queued", async ({ request }) => {
  const collectionId = await createCollectionWithImage(request);

  // dev server 首次访问这个路由会即时编译；先发一次请求预热，再测量真实响应时间。
  await createTask(request, collectionId, { imageCount: 1 });

  const started = Date.now();
  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: { visualStyle: "fresh", copyStyle: "story", imageCount: 2, extraPrompt: null },
  });
  const elapsed = Date.now() - started;

  expect(response.status()).toBe(201);
  expect(elapsed).toBeLessThan(1000);

  const task = ((await response.json()) as { data: { task: TaskView } }).data.task;
  expect(task.status).toBe("running");
  expect(task.statusLabel).toBe("执行中");
  expect(task.stages.image).toMatchObject({ status: "queued", statusLabel: "排队中", attempts: 1 });
  expect(task.stages.copy).toMatchObject({ status: "queued", statusLabel: "排队中", attempts: 1 });
  expect(task.resultId).toBeNull();
});

test("AC-04-2 两个阶段都成功后任务为 succeeded 并关联到结果", async ({ request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, { imageCount: 2 });

  const task = await waitForTerminal(request, created.id, "succeeded");
  expect(task.stages.image.status).toBe("succeeded");
  expect(task.stages.copy.status).toBe("succeeded");
  expect(task.resultId).toBeTruthy();
  expect(task.result?.assets).toHaveLength(2);
  expect(task.result?.title?.length).toBeGreaterThan(0);
  expect(task.result?.body?.length).toBeGreaterThan(0);
  expect(task.result?.tags.length).toBeGreaterThan(0);
});

test("AC-04-3 同一资源夹连续创建两次任务，产生两条任务与两个结果", async ({ request }) => {
  const collectionId = await createCollectionWithImage(request);

  const first = await waitForTerminal(request, (await createTask(request, collectionId)).id);
  const second = await waitForTerminal(request, (await createTask(request, collectionId)).id);

  expect(first.id).not.toBe(second.id);
  expect(first.resultId).toBeTruthy();
  expect(second.resultId).toBeTruthy();
  expect(first.resultId).not.toBe(second.resultId);

  const tasks = await listTasksOfCollection(request, collectionId);
  expect(tasks).toHaveLength(2);
});

test("AC-04-9 重新生成新建任务，旧任务的旧结果仍在", async ({ request }) => {
  const collectionId = await createCollectionWithImage(request);

  const original = await waitForTerminal(request, (await createTask(request, collectionId)).id);
  const regenerated = await waitForTerminal(request, (await createTask(request, collectionId)).id);

  const originalAgain = await getTask(request, original.id);
  expect(originalAgain.resultId).toBe(original.resultId);
  expect(originalAgain.result?.assets).toHaveLength(original.result?.assets.length ?? 0);
  expect(regenerated.resultId).not.toBe(original.resultId);
});

test("AC-04-4 停用图片 Agent 后创建任务被拒绝（AGENT_NOT_READY），不产生任务记录", async ({
  request,
}) => {
  const collectionId = await createCollectionWithImage(request);
  await patchAgent(request, "image", { enabled: false });

  const response = await request.post(`/api/collections/${collectionId}/tasks`, {
    data: { visualStyle: "fresh", copyStyle: "story", imageCount: 1, extraPrompt: null },
  });

  expect(response.status()).toBe(409);
  const body = (await response.json()) as ErrorBody;
  expect(body.error.code).toBe("CONFLICT");
  expect(body.error.details?.code).toBe("AGENT_NOT_READY");

  expect(await listTasksOfCollection(request, collectionId)).toHaveLength(0);

  // 还原，避免影响后续用例。
  const gatewayId = await ensureGateway(request);
  await patchAgent(request, "image", { enabled: true, gatewayId, gatewayModelId: null });
});

test("AC-04-6 对 partial 任务重试：只有文案阶段重跑，attempts 变为 2，图片未被替换", async ({
  request,
}) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, {
    imageCount: 2,
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });

  const partial = await waitForTerminal(request, created.id, "partial");
  expect(partial.stages.copy).toMatchObject({ status: "failed", attempts: 1 });
  const imageFinishedAt = partial.stages.image.finishedAt;
  const assetIdsBefore = partial.result?.assets.map((asset) => asset.id) ?? [];
  expect(assetIdsBefore).toHaveLength(2);

  const retried = await request.post(`/api/tasks/${created.id}/retry`);
  expect(retried.status()).toBe(200);
  const retriedTask = ((await retried.json()) as { data: { task: TaskView } }).data.task;
  expect(retriedTask.stages.copy).toMatchObject({ status: "queued", attempts: 2 });
  expect(retriedTask.stages.image).toMatchObject({ status: "succeeded", attempts: 1 });

  const finished = await waitForTerminal(request, created.id, "succeeded");
  expect(finished.stages.copy.attempts).toBe(2);
  expect(finished.stages.image.attempts).toBe(1);
  expect(finished.stages.image.finishedAt).toBe(imageFinishedAt);
  expect(finished.resultId).toBe(partial.resultId);
  expect(finished.result?.assets.map((asset) => asset.id)).toEqual(assetIdsBefore);
  expect(finished.result?.title?.length).toBeGreaterThan(0);
});

test("AC-04-8 全部成功的任务重试返回 CONFLICT，不产生副作用", async ({ request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await waitForTerminal(request, (await createTask(request, collectionId)).id, "succeeded");

  const response = await request.post(`/api/tasks/${created.id}/retry`);
  expect(response.status()).toBe(409);
  const body = (await response.json()) as ErrorBody;
  expect(body.error.code).toBe("CONFLICT");
  expect(body.error.details?.code).toBe("NO_FAILED_STAGE");

  const after = await getTask(request, created.id);
  expect(after.stages.copy.attempts).toBe(created.stages.copy.attempts);
  expect(after.stages.image.attempts).toBe(created.stages.image.attempts);
});

test("AC-05-12 连续两次重试：第二次因阶段已在跑返回 CONFLICT，不重复入队", async ({
  request,
}) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, {
    imageCount: 1,
    extraPrompt: MOCK_SCRIPT_HINTS.failCopyOnce,
  });
  await waitForTerminal(request, created.id, "partial");

  const first = await request.post(`/api/tasks/${created.id}/retry`);
  expect(first.status()).toBe(200);

  const second = await request.post(`/api/tasks/${created.id}/retry`);
  expect(second.status()).toBe(409);
  const body = (await second.json()) as ErrorBody;
  expect(body.error.code).toBe("CONFLICT");
  expect(body.error.details?.code).toBe("NO_FAILED_STAGE");

  const finished = await waitForTerminal(request, created.id, "succeeded");
  // 只加了一次：第二次请求没有把文案阶段重新排队。
  expect(finished.stages.copy.attempts).toBe(2);
});

test("AC-03-8 任务创建后修改 Agent 提示词，任务详情里的快照不变", async ({ request }) => {
  const collectionId = await createCollectionWithImage(request);
  const created = await createTask(request, collectionId, { imageCount: 1 });
  const snapshotPrompt = created.agents?.copy.systemPrompt ?? "";
  expect(snapshotPrompt.length).toBeGreaterThan(0);

  const changedPrompt = `改过的提示词-${uniqueName("e2e")}`;
  await patchAgent(request, "copy", { systemPrompt: changedPrompt });

  try {
    const detail = await getTask(request, created.id);
    expect(detail.agents?.copy.systemPrompt).toBe(snapshotPrompt);
    expect(detail.agents?.copy.systemPrompt).not.toBe(changedPrompt);
  } finally {
    const reset = await request.post("/api/agents/copy/reset");
    expect(reset.status()).toBe(200);
  }
});
