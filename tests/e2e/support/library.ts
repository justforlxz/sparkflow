import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { EXTRACTION_TERMINAL_STATUSES } from "../../../src/modules/extraction/constants";
import { ACCOUNT, ensureAccount } from "./auth";

/**
 * 素材库 / 提取运行 / 文案版本共用的端到端预备动作。
 *
 * 「发布」与「素材库」两份 spec 都要造资源夹、造网关、跑提取、等终态 ——
 * 这些步骤只写一份，避免两份用例对同一件事各自维护一套判定（尤其等终态的时机）。
 * 走真实 HTTP + 进程内 worker + mock 适配器（`GENERATION_ADAPTER=mock`）。
 */

/** 1×1 的 PNG：类型判定只看魔数。 */
export const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface LibraryAsset {
  id: string;
  category: string;
  categoryLabel: string;
  sourceAssetId: string;
  sourceAssetIndex: number | null;
  url: string;
}

export interface LibraryBody {
  ok: true;
  data: { groups: Array<{ category: string; label: string; items: LibraryAsset[] }>; total: number };
}

export interface ExtractionRun {
  id: string;
  status: string;
  progress: { done: number; total: number } | null;
  error: { code: string; message: string; failures: unknown[] } | null;
}

export interface CopyVersion {
  id: string;
  versionNo: number;
  versionLabel: string;
  status: string;
  title: string | null;
  selectedAssetIds: string[];
  assets: Array<{ id: string; deleted: boolean; categoryLabel: string | null }>;
  error: { code: string; message: string } | null;
}

const createdCollections: string[] = [];
const createdGateways: string[] = [];

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function createCollection(
  request: APIRequestContext,
  name: string,
  imageCount: number,
): Promise<{ id: string; assetIds: string[] }> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name,
    platform: "小红书",
  };
  for (let index = 0; index < imageCount; index += 1) {
    multipart[`images-${index}`] = {
      name: `a${index}.png`,
      mimeType: "image/png",
      buffer: PNG_ONE_PIXEL,
    };
  }

  const response = await request.post("/api/collections", { multipart });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    ok: true;
    data: { id: string; assets: Array<{ id: string }> };
  };
  createdCollections.push(body.data.id);
  return { id: body.data.id, assetIds: body.data.assets.map((asset) => asset.id) };
}

/** 造一个网关并绑定对应的 Agent：`magpie-mcp` 给图片 Agent，`openai-chat` 给文案 Agent。 */
export async function createGateway(
  request: APIRequestContext,
  protocol: "magpie-mcp" | "openai-chat",
  agentType: "image" | "copy",
): Promise<void> {
  const response = await request.post("/api/gateways", {
    data: {
      name: uniqueName(`e2e-lib-${agentType}`),
      protocol,
      baseUrl: "https://example.com",
      apiKey: "test-key-placeholder",
    },
  });
  expect(response.status()).toBe(201);
  const gateway = ((await response.json()) as { data: { gateway: { id: string } } }).data.gateway;
  createdGateways.push(gateway.id);

  let gatewayModelId: string | null = null;
  if (agentType === "copy") {
    const model = await request.post(`/api/gateways/${gateway.id}/models`, {
      data: { modelId: "gpt-4o-mini", capability: "text" },
    });
    expect(model.status()).toBe(201);
    gatewayModelId = "gpt-4o-mini";
  }

  const bind = await request.patch(`/api/agents/${agentType}`, {
    data: { gatewayId: gateway.id, gatewayModelId },
  });
  expect(bind.status()).toBe(200);
}

export async function listLibrary(
  request: APIRequestContext,
  collectionId: string,
): Promise<LibraryBody["data"]> {
  const response = await request.get(`/api/collections/${collectionId}/library`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as LibraryBody).data;
}

export async function listRuns(
  request: APIRequestContext,
  collectionId: string,
): Promise<ExtractionRun[]> {
  const response = await request.get(`/api/collections/${collectionId}/extractions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { runs: ExtractionRun[] } }).data.runs;
}

export async function listVersions(
  request: APIRequestContext,
  collectionId: string,
): Promise<CopyVersion[]> {
  const response = await request.get(`/api/collections/${collectionId}/copy-versions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { versions: CopyVersion[] } }).data.versions;
}

/**
 * 等到提取运行进入**终态**（`succeeded` / `partial` / `failed`）。
 *
 * 不能只等到「不再是 queued」：worker 认领后状态先变成 running，那时素材还没入库，
 * 后续断言会读到半成品（CI 上就是这样失败的）。终态清单取自服务端常量，避免两处口径漂移。
 */
export async function waitForRun(
  request: APIRequestContext,
  collectionId: string,
  runId: string,
): Promise<ExtractionRun> {
  let latest: ExtractionRun | undefined;
  await expect
    .poll(
      async () => {
        latest = (await listRuns(request, collectionId)).find((run) => run.id === runId);
        return latest !== undefined && isTerminalRun(latest.status);
      },
      { timeout: 40_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  if (!latest) throw new Error(`提取运行 ${runId} 没有出现在列表里`);
  return latest;
}

function isTerminalRun(status: string): boolean {
  return (EXTRACTION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export async function waitForVersion(
  request: APIRequestContext,
  collectionId: string,
  versionId: string,
): Promise<CopyVersion> {
  let latest: CopyVersion | undefined;
  // 等到终态（成功或失败）再断言成功：把「失败」当超时等只会给出含糊的等待超时。
  await expect
    .poll(
      async () => {
        latest = (await listVersions(request, collectionId)).find(
          (version) => version.id === versionId,
        );
        return latest?.status === "succeeded" || latest?.status === "failed";
      },
      { timeout: 40_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  if (!latest) throw new Error(`文案版本 ${versionId} 没有出现在列表里`);
  expect(latest.status, `生成失败：${latest.error?.message ?? "未知原因"}`).toBe("succeeded");
  return latest;
}

/** 浏览器上下文与 `request` 各自持有 cookie：页面在页面上登录，接口用 ensureAccount。 */
export async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

/** 界面用例的数据准备走接口：发起一次提取并等它进入终态，断言只看界面。 */
export async function extractAndWait(
  request: APIRequestContext,
  collection: { id: string; assetIds: string[] },
  options: { categories?: string[]; extraPrompt?: string } = {},
): Promise<ExtractionRun> {
  const response = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: options.categories ?? ["material"],
      requirement: "faithful",
      extraPrompt: options.extraPrompt,
    },
  });
  expect(response.status()).toBe(201);
  const run = ((await response.json()) as { data: { run: ExtractionRun } }).data.run;
  return waitForRun(request, collection.id, run.id);
}

/** 每个用例从默认配置开始，避免上一条用例绑定的网关互相影响。 */
export async function prepareAgents(request: APIRequestContext): Promise<void> {
  await ensureAccount(request);
  for (const type of ["image", "copy"]) {
    const reset = await request.post(`/api/agents/${type}/reset`);
    expect(reset.status()).toBe(200);
  }
}

/**
 * 用例结束后的清理：删掉本文件造的资源夹与网关，并把 Agent 绑定写回未绑定。
 *
 * `afterAll` 拿到的 `request` 是新的上下文，没有用例里的登录 cookie：
 * 不先登录的话每个 DELETE 都是 401，数据悄悄留在库里，下一条用例的全局列表就会读到别人的记录。
 * 删除失败不再静默（404 视为已删），否则清理失灵只会推迟到后续用例才暴露。
 */
export async function cleanupLibraryData(request: APIRequestContext): Promise<void> {
  await ensureAccount(request);

  for (const id of createdCollections.splice(0)) {
    const response = await request.delete(`/api/collections/${id}`);
    expect([200, 404], `删除资源夹 ${id} 失败：${response.status()}`).toContain(
      response.status(),
    );
  }

  // 文案 Agent 的模型是必填项，接口不允许解绑（`AGENT_MODEL_REQUIRED`），
  // 只能直接写库还原，否则绑定的网关删不掉，而且会污染下一条用例的「默认未绑定」前提。
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      'UPDATE "agent_config" SET "gateway_id" = NULL, "gateway_model_id" = NULL',
    );
  } finally {
    await pool.end();
  }

  for (const id of createdGateways.splice(0)) {
    const response = await request.delete(`/api/gateways/${id}`);
    expect([200, 404], `删除网关 ${id} 失败：${response.status()}`).toContain(response.status());
  }
}