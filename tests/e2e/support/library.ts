import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import sharp from "sharp";
import { EXTRACTION_TERMINAL_STATUSES } from "../../../src/modules/extraction/constants";
import { ensureAccount } from "./auth";

/**
 * 素材库 / 提取运行共用的端到端预备动作。
 *
 * 各份 spec 都要造资源夹、造网关、跑提取、等终态 —— 这些步骤只写一份，避免多份用例对同一件事
 * 各自维护一套判定（尤其等终态的时机）。走真实 HTTP + 进程内 worker + mock 适配器
 * （`GENERATION_ADAPTER=mock`）。文案版本与发布记录的辅助函数随功能下线删除（MKACG-976）。
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
  width: number | null;
  height: number | null;
  url: string;
  /** 入库时间：同一张原图同一类别多次运行各写一条，「只保留最新」按它判断谁最新。 */
  createdAt: string;
}

/** 判定为不存在的条目（AC-LIB-11）：挂在对应组里，带模型原话。 */
export interface SkippedItem {
  id: string;
  category: string;
  categoryLabel: string;
  sourceAssetId: string;
  sourceAssetIndex: number | null;
  reason: string;
}

export interface LibraryBody {
  ok: true;
  data: {
    groups: Array<{
      category: string;
      label: string;
      items: LibraryAsset[];
      skipped: SkippedItem[];
    }>;
    total: number;
  };
}

export interface ExtractionRun {
  id: string;
  status: string;
  statusLabel: string;
  progress: { done: number; total: number } | null;
  error: { code: string; message: string; failures: unknown[] } | null;
}

const createdCollections: string[] = [];
const createdGateways: string[] = [];

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** 生成一张指定尺寸的纯色 PNG：AC-LIB-13 要断言「3:2 原图产出 3:2 图」，源图比例必须真实。 */
export async function pngOfSize(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 160 } } })
    .png()
    .toBuffer();
}

export async function createCollection(
  request: APIRequestContext,
  name: string,
  imageCount: number,
  options: { imageSize?: { width: number; height: number } } = {},
): Promise<{ id: string; assetIds: string[] }> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name,
    platform: "小红书",
  };
  const bytes = options.imageSize
    ? await pngOfSize(options.imageSize.width, options.imageSize.height)
    : PNG_ONE_PIXEL;
  for (let index = 0; index < imageCount; index += 1) {
    multipart[`images-${index}`] = {
      name: `a${index}.png`,
      mimeType: "image/png",
      buffer: bytes,
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

/** 造一个 `magpie-mcp` 网关并绑定图片 Agent。文案 Agent 下线后不再需要文案侧网关（MKACG-976）。 */
export async function createGateway(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/gateways", {
    data: {
      name: uniqueName("e2e-lib-image"),
      protocol: "magpie-mcp",
      baseUrl: "https://example.com",
      apiKey: "test-key-placeholder",
    },
  });
  expect(response.status()).toBe(201);
  const gateway = ((await response.json()) as { data: { gateway: { id: string } } }).data.gateway;
  createdGateways.push(gateway.id);

  const bind = await request.patch("/api/agents/image", {
    data: { gatewayId: gateway.id, gatewayModelId: null },
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

/** 界面用例的数据准备走接口：发起一次提取并等它进入终态，断言只看界面。 */
export async function extractAndWait(
  request: APIRequestContext,
  collection: { id: string; assetIds: string[] },
  options: { categories?: string[]; extraPrompt?: string } = {},
): Promise<ExtractionRun> {
  const response = await request.post(`/api/collections/${collection.id}/extractions`, {
    data: {
      sourceAssetIds: collection.assetIds,
      categories: options.categories ?? ["topdown"],
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
  const reset = await request.post("/api/agents/image/reset");
  expect(reset.status()).toBe(200);
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