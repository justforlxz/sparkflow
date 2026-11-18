import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { ensureAccount } from "./support/auth";

/**
 * 网关区块的验收（docs/prd/02-model-gateway.md AC-02-1 ~ AC-02-6，加上 AC-03-7）。
 *
 * 连接测试必须发真实请求，所以这里起一个本地 mock 端点：
 * 只有带对密钥的请求得到 2xx，其余 401；另起一个立刻关闭的端口用于「网络错误」。
 */

const TEST_KEY = "sk-e2e-gateway-test-key-000001";
const WRONG_KEY = "sk-e2e-wrong-key-00000000002";

let mockServer: http.Server;
let mockBaseUrl = "";
let deadBaseUrl = "";

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", ...extra };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test.beforeAll(async () => {
  mockServer = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const authorized = request.headers.authorization === `Bearer ${TEST_KEY}`;
      const url = request.url ?? "";

      if (url.endsWith("/chat/completions") || url.endsWith("/messages")) {
        if (!authorized) {
          response.writeHead(401, jsonHeaders()).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        response
          .writeHead(200, jsonHeaders())
          .end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
        return;
      }

      if (url.endsWith("/mcp/magpie/image")) {
        if (!authorized) {
          response.writeHead(401, jsonHeaders()).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const payload = JSON.parse(body || "{}") as { id?: number; method?: string };
        if (payload.method === "initialize") {
          response
            .writeHead(200, jsonHeaders({ "mcp-session-id": "e2e-session" }))
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: payload.id,
                result: { protocolVersion: "2025-06-18" },
              }),
            );
          return;
        }
        if (payload.method === "tools/list") {
          response.writeHead(200, jsonHeaders()).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: { tools: [{ name: "generate_image" }, { name: "generation_result" }] },
            }),
          );
          return;
        }
      }

      response.writeHead(404, jsonHeaders()).end(JSON.stringify({ error: "not found" }));
    });
  });

  const port = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${port}/v1`;

  // 先起再关，拿到一个必然拒绝连接的地址（网络错误类别）。
  const deadServer = http.createServer(() => {});
  const deadPort = await listen(deadServer);
  deadBaseUrl = `http://127.0.0.1:${deadPort}/v1`;
  await close(deadServer);
});

test.afterAll(async () => {
  await close(mockServer);
});

interface GatewayPayload {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyMask: string;
  hasApiKey: boolean;
  models: { modelId: string; capability: string }[];
  lastTest: { ok: boolean; outcome: string; message: string } | null;
}

/** 把接口上下文登录得到的会话 cookie 交给浏览器页面（两个 fixture 各有独立的 cookie 存储）。 */
async function useApiSession(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createGateway(
  request: import("@playwright/test").APIRequestContext,
  input: { name: string; baseUrl?: string; apiKey?: string; protocol?: string },
): Promise<GatewayPayload> {
  const response = await request.post("/api/gateways", {
    data: {
      name: input.name,
      protocol: input.protocol ?? "openai-chat",
      baseUrl: input.baseUrl ?? mockBaseUrl,
      apiKey: input.apiKey ?? TEST_KEY,
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: { gateway: GatewayPayload } };
  return body.data.gateway;
}

async function addModel(
  request: import("@playwright/test").APIRequestContext,
  gatewayId: string,
  modelId: string,
  capability: string,
): Promise<void> {
  const response = await request.post(`/api/gateways/${gatewayId}/models`, {
    data: { modelId, capability },
  });
  expect(response.status()).toBe(201);
}

async function deleteGateway(
  request: import("@playwright/test").APIRequestContext,
  gatewayId: string,
): Promise<void> {
  const response = await request.delete(`/api/gateways/${gatewayId}`);
  expect(response.status()).toBe(200);
}

test("AC-02-1 新增网关后可持久化，刷新仍在，密钥显示为掩码", async ({ page, request }) => {
  await ensureAccount(request);
  await useApiSession(page, request);
  const name = uniqueName("e2e-openai");

  await page.goto("/settings");
  await page.getByRole("button", { name: "新增网关" }).click();

  const dialog = page.getByRole("dialog", { name: "新增网关" });
  await dialog.getByLabel("网关名称").fill(name);
  await dialog.getByLabel("接口形状").selectOption("openai-chat");
  await dialog.getByLabel("Base URL").fill(`${mockBaseUrl}/`);
  await dialog.getByTestId("gateway-api-key").fill(TEST_KEY);

  // 密钥显示/隐藏：默认掩码，点「显示」才明文（只在输入框里，不回显到列表）
  const keyInput = dialog.getByTestId("gateway-api-key");
  await expect(keyInput).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "显示" }).click();
  await expect(keyInput).toHaveAttribute("type", "text");
  await expect(keyInput).toHaveValue(TEST_KEY);
  await dialog.getByRole("button", { name: "隐藏" }).click();
  await expect(keyInput).toHaveAttribute("type", "password");

  await dialog.getByRole("button", { name: "创建网关" }).click();

  const card = page.locator(`[data-testid="gateway-card"][data-gateway-name="${name}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("gateway-api-key-mask")).toContainText("••••");
  await expect(card).not.toContainText(TEST_KEY);

  await page.reload();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("gateway-api-key-mask")).toContainText("••••");

  const list = (await (await request.get("/api/gateways")).json()) as {
    data: { gateways: GatewayPayload[] };
  };
  const created = list.data.gateways.find((gateway) => gateway.name === name);
  expect(created).toMatchObject({ protocol: "openai-chat", hasApiKey: true });
  expect(created?.apiKeyMask).toMatch(/^••••/);
  // Base URL 去掉尾部斜杠后再保存（SHOULD）
  expect(created?.baseUrl).toBe(mockBaseUrl);

  await deleteGateway(request, created!.id);
});

test("AC-02-2 接口响应与页面源码中不出现完整密钥", async ({ page, request }) => {
  await ensureAccount(request);
  await useApiSession(page, request);
  const name = uniqueName("e2e-secret-scan");
  const apiBodies: Promise<string>[] = [];

  page.on("response", (response) => {
    if (!response.url().includes("/api/")) return;
    apiBodies.push(response.text().catch(() => ""));
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "新增网关" }).click();
  const dialog = page.getByRole("dialog", { name: "新增网关" });
  await dialog.getByLabel("网关名称").fill(name);
  await dialog.getByLabel("Base URL").fill(mockBaseUrl);
  await dialog.getByTestId("gateway-api-key").fill(TEST_KEY);
  await dialog.getByRole("button", { name: "创建网关" }).click();

  const card = page.locator(`[data-testid="gateway-card"][data-gateway-name="${name}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByRole("status")).toBeVisible();

  const html = await page.content();
  const bodies = await Promise.all(apiBodies);
  expect(bodies.length).toBeGreaterThan(0);

  expect(html).not.toContain(TEST_KEY);
  for (const body of bodies) expect(body).not.toContain(TEST_KEY);
  expect(await (await request.get("/api/gateways")).text()).not.toContain(TEST_KEY);

  const list = (await (await request.get("/api/gateways")).json()) as {
    data: { gateways: GatewayPayload[] };
  };
  const created = list.data.gateways.find((gateway) => gateway.name === name);
  await deleteGateway(request, created!.id);
});

test("AC-02-3 未重输密钥的编辑保存后，原密钥仍可用（连接测试成功）", async ({ page, request }) => {
  await ensureAccount(request);
  await useApiSession(page, request);
  const gateway = await createGateway(request, { name: uniqueName("e2e-keep-key") });
  const renamed = `${gateway.name}-改名`;

  try {
    await page.goto("/settings");
    const card = page.locator(`[data-testid="gateway-card"][data-gateway-name="${gateway.name}"]`);
    await card.getByRole("button", { name: "编辑" }).click();

    const dialog = page.getByRole("dialog", { name: "编辑网关" });
    // 模型清单增：文本协议需要 text 能力的模型才能测通
    await dialog.getByLabel("模型 ID").fill("gpt-4o-mini");
    await dialog.getByLabel("能力").selectOption("text");
    await dialog.getByRole("button", { name: "添加模型" }).click();
    await expect(dialog.getByText("gpt-4o-mini")).toBeVisible();

    // 只改名，密钥输入框留空
    await dialog.getByLabel("网关名称").fill(renamed);
    await expect(dialog.getByTestId("gateway-api-key")).toHaveValue("");
    await dialog.getByRole("button", { name: "保存" }).click();

    const renamedCard = page.locator(
      `[data-testid="gateway-card"][data-gateway-name="${renamed}"]`,
    );
    await expect(renamedCard).toBeVisible();

    // mock 端点只认原密钥：保存后仍能通过，说明密钥被保留
    await renamedCard.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByRole("status")).toContainText("OpenAI Chat 接口可用");

    const list = (await (await request.get("/api/gateways")).json()) as {
      data: { gateways: GatewayPayload[] };
    };
    const updated = list.data.gateways.find((entry) => entry.id === gateway.id);
    expect(updated?.hasApiKey).toBe(true);
    expect(updated?.models.map((model) => model.modelId)).toEqual(["gpt-4o-mini"]);
    expect(updated?.lastTest).toMatchObject({ ok: true, outcome: "ok" });

    // 模型清单删：空清单时界面给出提示
    await renamedCard.getByRole("button", { name: "编辑" }).click();
    const reopen = page.getByRole("dialog", { name: "编辑网关" });
    await reopen.getByRole("button", { name: "移除模型 gpt-4o-mini" }).click();
    await expect(reopen.getByText("还没有模型。")).toBeVisible();
  } finally {
    await deleteGateway(request, gateway.id);
  }
});

// 引用方是 Agent 配置（N4 交付的目标）：绑定到图片 Agent 后网关不能删。
// 图片 Agent 的模型可以为空，所以绑定与解绑都能经接口完成，测试不留下残留。
test("AC-02-4 删除被引用的网关返回 409 并指出引用方", async ({ request }) => {
  await ensureAccount(request);
  const gateway = await createGateway(request, { name: uniqueName("e2e-in-use") });

  try {
    await addModel(request, gateway.id, "gpt-image-1", "image");

    const bound = await request.patch("/api/agents/image", {
      data: { gatewayId: gateway.id, gatewayModelId: "gpt-image-1" },
    });
    expect(bound.status()).toBe(200);

    const blocked = await request.delete(`/api/gateways/${gateway.id}`);
    expect(blocked.status()).toBe(409);

    const body = (await blocked.json()) as {
      error: { message: string; details?: { code: string } };
    };
    expect(body.error.details?.code).toBe("GATEWAY_IN_USE");
    expect(body.error.message).toContain("图片创作 Agent");

    // 解除绑定后可以删除
    const unbound = await request.patch("/api/agents/image", {
      data: { gatewayId: null, gatewayModelId: null },
    });
    expect(unbound.status()).toBe(200);

    const removed = await request.delete(`/api/gateways/${gateway.id}`);
    expect(removed.status()).toBe(200);
  } finally {
    await request.patch("/api/agents/image", { data: { gatewayId: null, gatewayModelId: null } });
    await request.delete(`/api/gateways/${gateway.id}`);
  }
});

test("AC-02-5 text 能力的模型不出现在图片 Agent 候选里", async ({ request }) => {
  await ensureAccount(request);
  const gateway = await createGateway(request, { name: uniqueName("e2e-capability") });

  try {
    await addModel(request, gateway.id, "gpt-4o-mini", "text");
    await addModel(request, gateway.id, "gpt-image-1", "image");

    // 同一网关内 model_id 唯一（MUST 5）
    const duplicate = await request.post(`/api/gateways/${gateway.id}/models`, {
      data: { modelId: "gpt-image-1", capability: "image" },
    });
    expect(duplicate.status()).toBe(409);

    const imageBody = (await (
      await request.get("/api/gateways/models?capability=image")
    ).json()) as { data: { models: { gatewayId: string; modelId: string; capability: string }[] } };
    const imageCandidates = imageBody.data.models.filter((model) => model.gatewayId === gateway.id);
    expect(imageCandidates.map((model) => model.modelId)).toEqual(["gpt-image-1"]);
    expect(imageCandidates.every((model) => model.capability === "image")).toBe(true);

    const textBody = (await (
      await request.get("/api/gateways/models?capability=text")
    ).json()) as { data: { models: { gatewayId: string; modelId: string }[] } };
    const textCandidates = textBody.data.models.filter((model) => model.gatewayId === gateway.id);
    expect(textCandidates.map((model) => model.modelId)).toEqual(["gpt-4o-mini"]);
  } finally {
    await deleteGateway(request, gateway.id);
  }
});

test("AC-02-6 连接测试能区分鉴权失败与网络错误", async ({ page, request }) => {
  await ensureAccount(request);
  await useApiSession(page, request);
  const authGateway = await createGateway(request, {
    name: uniqueName("e2e-auth"),
    apiKey: WRONG_KEY,
  });
  const networkGateway = await createGateway(request, {
    name: uniqueName("e2e-network"),
    baseUrl: deadBaseUrl,
  });

  try {
    await addModel(request, authGateway.id, "gpt-4o-mini", "text");
    await addModel(request, networkGateway.id, "gpt-4o-mini", "text");

    const authBody = (await (await request.post(`/api/gateways/${authGateway.id}/test`)).json()) as {
      data: { result: { ok: boolean; outcome: string; message: string } };
    };
    expect(authBody.data.result).toMatchObject({ ok: false, outcome: "auth" });
    expect(authBody.data.result.message).not.toContain(WRONG_KEY);

    const networkBody = (await (
      await request.post(`/api/gateways/${networkGateway.id}/test`)
    ).json()) as { data: { result: { ok: boolean; outcome: string; message: string } } };
    expect(networkBody.data.result).toMatchObject({ ok: false, outcome: "network" });

    await page.goto("/settings");
    await expect(
      page.locator(`[data-testid="gateway-card"][data-gateway-name="${authGateway.name}"]`),
    ).toContainText("鉴权失败");
    await expect(
      page.locator(`[data-testid="gateway-card"][data-gateway-name="${networkGateway.name}"]`),
    ).toContainText("网络错误");
  } finally {
    await deleteGateway(request, authGateway.id);
    await deleteGateway(request, networkGateway.id);
  }
});

test("AC-03-7 页面源码与所有接口响应中搜索测试密钥全文，命中 0 次", async ({ page, request }) => {
  await ensureAccount(request);
  await useApiSession(page, request);
  const gateway = await createGateway(request, { name: uniqueName("e2e-html-scan") });
  const apiBodies: Promise<string>[] = [];

  try {
    await addModel(request, gateway.id, "gpt-4o-mini", "text");

    page.on("response", (response) => {
      if (!response.url().includes("/api/")) return;
      apiBodies.push(response.text().catch(() => ""));
    });

    await page.goto("/settings");
    const card = page.locator(`[data-testid="gateway-card"][data-gateway-name="${gateway.name}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    const html = await page.content();
    const bodies = await Promise.all(apiBodies);

    const hits = [html, ...bodies].reduce(
      (count, text) => count + (text.includes(TEST_KEY) ? 1 : 0),
      0,
    );
    expect(hits).toBe(0);
  } finally {
    await deleteGateway(request, gateway.id);
  }
});
