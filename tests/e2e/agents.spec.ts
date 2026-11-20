import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AGENT_DEFAULTS } from "../../src/modules/agent-config/defaults";
import { ensureAccount } from "./support/auth";

/**
 * Agent 配置与功能开关区块的验收（docs/prd/03-agent-config.md AC-03-1 ~ AC-03-6，
 * docs/prd/10-feature-flags.md AC-10-6）。
 *
 * 只绑定「图片 Agent」：它的模型可以为空，因此每步都能经接口还原（`gatewayId` 与
 * `gatewayModelId` 清空），测试不留下改不掉的绑定。文案 Agent 必须绑模型，
 * 一旦绑上就无法经接口解绑，会连带让网关删不掉 —— 那条规则由单测覆盖。
 */

interface AgentPayload {
  type: string;
  label: string;
  enabled: boolean;
  name: string;
  gatewayId: string | null;
  gatewayModelId: string | null;
  role: string;
  systemPrompt: string;
  outputRequirements: string;
  modelRequired: boolean;
  emptyModelLabel: string | null;
  state: string;
  ready: boolean;
  issues: string[];
}

interface GatewayPayload {
  id: string;
  name: string;
}

interface ModelCandidate {
  gatewayId: string;
  modelId: string;
  capability: string;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 把接口上下文登录得到的会话 cookie 交给浏览器页面（两个 fixture 各有独立的 cookie 存储）。 */
async function useApiSession(page: Page, request: APIRequestContext): Promise<void> {
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
}

async function createGateway(
  request: APIRequestContext,
  input: { name: string; models: { modelId: string; capability: string }[] },
): Promise<GatewayPayload> {
  const response = await request.post("/api/gateways", {
    data: {
      name: input.name,
      protocol: "openai-chat",
      baseUrl: "https://gw.agent-e2e.example.com/v1",
      // 只用来说明「网关有一把密钥」；这里的用例从不发起真实请求。
      apiKey: "agent-e2e-placeholder-key",
    },
  });
  expect(response.status()).toBe(201);
  const created = (await response.json()) as { data: { gateway: GatewayPayload } };

  for (const model of input.models) {
    const added = await request.post(`/api/gateways/${created.data.gateway.id}/models`, {
      data: model,
    });
    expect(added.status()).toBe(201);
  }

  return created.data.gateway;
}

function deleteGateway(request: APIRequestContext, gatewayId: string): Promise<unknown> {
  return request.delete(`/api/gateways/${gatewayId}`);
}

async function getAgents(request: APIRequestContext): Promise<AgentPayload[]> {
  const response = await request.get("/api/agents");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { agents: AgentPayload[] } }).data.agents;
}

async function getAgent(request: APIRequestContext, type: string): Promise<AgentPayload> {
  const agents = await getAgents(request);
  const agent = agents.find((entry) => entry.type === type);
  expect(agent, `缺少 ${type} Agent`).toBeDefined();
  return agent!;
}

async function patchAgent(
  request: APIRequestContext,
  type: string,
  data: Record<string, unknown>,
): Promise<AgentPayload> {
  const response = await request.patch(`/api/agents/${type}`, { data });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { agent: AgentPayload } }).data.agent;
}

async function modelCandidates(
  request: APIRequestContext,
  type: string,
): Promise<ModelCandidate[]> {
  const response = await request.get(`/api/agents/models?type=${type}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { models: ModelCandidate[] } }).data.models;
}

function agentCard(page: Page, type: string) {
  return page.locator(`[data-testid="agent-card-${type}"]`);
}

test.beforeEach(async ({ request }) => {
  await ensureAccount(request);

  // 每个用例从「默认文案 + 图片 Agent 未绑定」开始，避免互相影响。
  for (const type of ["image", "copy"]) {
    const reset = await request.post(`/api/agents/${type}/reset`);
    expect(reset.status()).toBe(200);
  }
  await patchAgent(request, "image", { gatewayId: null, gatewayModelId: null });
});

test("AC-03-1 两条配置互相独立：改文案 Agent 提示词不影响图片 Agent", async ({ request }) => {
  const prompt = `临时提示词-${Date.now().toString(36)}`;

  const updated = await patchAgent(request, "copy", { systemPrompt: prompt });
  expect(updated.systemPrompt).toBe(prompt);

  const image = await getAgent(request, "image");
  expect(image.systemPrompt).toBe(AGENT_DEFAULTS.image.systemPrompt);
  expect(image.systemPrompt).not.toBe(prompt);
});

test("AC-03-2 图片 Agent 的候选里没有 text 能力的模型", async ({ page, request }) => {
  const gateway = await createGateway(request, {
    name: uniqueName("e2e-agent-capability"),
    models: [
      { modelId: "gpt-image-1", capability: "image" },
      { modelId: "gpt-4o-mini", capability: "text" },
      { modelId: "qwen-vl", capability: "image_input" },
    ],
  });

  try {
    const imageCandidates = (await modelCandidates(request, "image")).filter(
      (model) => model.gatewayId === gateway.id,
    );
    expect(imageCandidates.map((model) => model.modelId)).toEqual(["gpt-image-1"]);

    const copyCandidates = (await modelCandidates(request, "copy")).filter(
      (model) => model.gatewayId === gateway.id,
    );
    expect(copyCandidates.map((model) => model.modelId).sort()).toEqual(["gpt-4o-mini", "qwen-vl"]);

    await useApiSession(page, request);
    await page.goto("/settings");
    const card = agentCard(page, "image");
    await card.getByTestId("agent-gateway").selectOption({ label: gateway.name });

    const options = card.getByTestId("agent-model").locator("option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(1)).toHaveText(/gpt-image-1/);
    await expect(card.getByTestId("agent-model")).not.toContainText("gpt-4o-mini");
  } finally {
    await deleteGateway(request, gateway.id);
  }
});

test("AC-03-3 图片 Agent 的模型留空可以保存，状态显示为使用网关默认图片模型", async ({
  page,
  request,
}) => {
  const gateway = await createGateway(request, {
    name: uniqueName("e2e-agent-default-model"),
    models: [{ modelId: "gpt-image-1", capability: "image" }],
  });

  try {
    await useApiSession(page, request);
    await page.goto("/settings");

    const card = agentCard(page, "image");
    await card.getByTestId("agent-gateway").selectOption({ label: gateway.name });
    await card.getByTestId("agent-model").selectOption("");
    await card.getByRole("button", { name: "保存" }).click();

    await expect(card.getByRole("status")).toContainText("已保存");
    await expect(card.getByTestId("agent-binding-state")).toContainText("使用网关默认图片模型");

    const image = await getAgent(request, "image");
    expect(image).toMatchObject({
      gatewayId: gateway.id,
      gatewayModelId: null,
      state: "gateway-default",
      ready: true,
    });
  } finally {
    await patchAgent(request, "image", { gatewayId: null, gatewayModelId: null });
    await deleteGateway(request, gateway.id);
  }
});

test("AC-03-4 文案 Agent 的模型留空保存被拒绝，错误指出原因", async ({ page, request }) => {
  const gateway = await createGateway(request, {
    name: uniqueName("e2e-agent-copy-required"),
    models: [{ modelId: "gpt-4o-mini", capability: "text" }],
  });

  try {
    const response = await request.patch("/api/agents/copy", {
      data: { gatewayId: gateway.id, gatewayModelId: null },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: { code: string } };
    };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.code).toBe("AGENT_MODEL_REQUIRED");
    expect(body.error.message).toContain("必须绑定");
    expect(body.error.message).toContain("模型");

    await useApiSession(page, request);
    await page.goto("/settings");
    const card = agentCard(page, "copy");
    await card.getByTestId("agent-gateway").selectOption({ label: gateway.name });
    await card.getByRole("button", { name: "保存" }).click();

    await expect(card.getByRole("alert")).toContainText("必须绑定");
    // 保存失败不改变库里的配置
    expect((await getAgent(request, "copy")).gatewayId).toBeNull();
  } finally {
    await deleteGateway(request, gateway.id);
  }
});

test("AC-03-5 选择不属于该网关的模型、或已删除的网关时，保存被拒绝而不是 500", async ({
  page,
  request,
}) => {
  const gatewayA = await createGateway(request, {
    name: uniqueName("e2e-agent-gw-a"),
    models: [{ modelId: "gpt-4o-mini", capability: "text" }],
  });
  const gatewayB = await createGateway(request, {
    name: uniqueName("e2e-agent-gw-b"),
    models: [{ modelId: "claude-sonnet", capability: "text" }],
  });
  const deleted = await createGateway(request, {
    name: uniqueName("e2e-agent-gw-deleted"),
    models: [],
  });

  try {
    // 1) 模型属于另一个网关
    const response = await request.patch("/api/agents/copy", {
      data: { gatewayId: gatewayA.id, gatewayModelId: "claude-sonnet" },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as {
      error: { message: string; details?: { code: string } };
    };
    expect(body.error.details?.code).toBe("AGENT_MODEL_NOT_IN_GATEWAY");
    expect(body.error.message).toContain("claude-sonnet");
    expect(body.error.message).toContain(gatewayA.name);

    // 2) 页面上的网关下拉来自首屏数据：网关被删掉后仍能选中，保存必须返回 VALIDATION_FAILED。
    //    模型留空的分支曾经在校验网关之前提前返回，把这个不存在的 id 写进库，
    //    被外键拒绝后退化成 500（评审阻断项）。
    await useApiSession(page, request);
    await page.goto("/settings");
    await deleteGateway(request, deleted.id);

    const card = agentCard(page, "image");
    await card.getByTestId("agent-gateway").selectOption({ label: deleted.name });
    await card.getByRole("button", { name: "保存" }).click();

    await expect(card.getByRole("alert")).toContainText("网关不存在");
    expect((await getAgent(request, "image")).gatewayId).toBeNull();
  } finally {
    await deleteGateway(request, gatewayA.id);
    await deleteGateway(request, gatewayB.id);
    await deleteGateway(request, deleted.id);
  }
});

test("AC-03-6 / AC-WM-5 恢复默认需确认，确认后提示词与输出要求回默认值、模型绑定不变", async ({ page, request }) => {
  const gateway = await createGateway(request, {
    name: uniqueName("e2e-agent-reset"),
    models: [{ modelId: "gpt-image-1", capability: "image" }],
  });

  try {
    await patchAgent(request, "image", {
      gatewayId: gateway.id,
      gatewayModelId: "gpt-image-1",
      systemPrompt: "临时提示词",
      outputRequirements: "临时输出要求",
    });

    await useApiSession(page, request);
    await page.goto("/settings");
    const card = agentCard(page, "image");
    await expect(card.getByLabel("系统提示词")).toHaveValue("临时提示词");
    await expect(card.getByLabel("输出要求")).toHaveValue("临时输出要求");

    await card.getByRole("button", { name: "恢复默认" }).click();
    await expect(card.getByText("恢复默认会重置")).toBeVisible();
    // 未确认之前不生效
    expect((await getAgent(request, "image")).systemPrompt).toBe("临时提示词");

    await card.getByRole("button", { name: "确认恢复" }).click();
    await expect(card.getByRole("status")).toContainText("已恢复默认");
    await expect(card.getByLabel("系统提示词")).toHaveValue(AGENT_DEFAULTS.image.systemPrompt);
    await expect(card.getByLabel("输出要求")).toHaveValue(AGENT_DEFAULTS.image.outputRequirements);

    const image = await getAgent(request, "image");
    expect(image.systemPrompt).toBe(AGENT_DEFAULTS.image.systemPrompt);
    expect(image.outputRequirements).toBe(AGENT_DEFAULTS.image.outputRequirements);
    expect(image.gatewayId).toBe(gateway.id);
    expect(image.gatewayModelId).toBe("gpt-image-1");
  } finally {
    await patchAgent(request, "image", { gatewayId: null, gatewayModelId: null });
    await deleteGateway(request, gateway.id);
  }
});

test("AC-10-6 设置页的功能开关区块显示两项、标注本版本未实现且开关不可操作", async ({
  page,
  request,
}) => {
  await useApiSession(page, request);
  await page.goto("/settings");

  const section = page.locator('[aria-label="功能开关"]');
  // 图生图已实现：不标「本版本未实现」，开关可操作；分享仍未实现。
  await expect(section.getByTestId("feature-unimplemented")).toHaveCount(1);

  const imageToImage = page.getByTestId("feature-flag-image-to-image");
  await expect(imageToImage).toBeVisible();
  await expect(imageToImage.getByTestId("feature-unimplemented")).toHaveCount(0);
  await expect(imageToImage.getByRole("checkbox")).toBeEnabled();

  const share = page.getByTestId("feature-flag-share-to-xiaohongshu");
  await expect(share).toBeVisible();
  await expect(share.getByTestId("feature-unimplemented")).toHaveText("本版本未实现");
  await expect(share.getByRole("checkbox")).toBeDisabled();
});
