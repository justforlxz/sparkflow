import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { EXTRACTION_ERROR_CODES } from "./constants";
import { createExtractionRunner } from "./runner";
import type { ExtractionStore, LibraryWriter } from "./store";
import type {
  CollectionContext,
  ExtractedImage,
  ExtractionHandler,
  ExtractionRunRecord,
  LibraryAssetInput,
} from "./types";

const AGENT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片提取 Agent",
  gatewayId: "gateway-1",
  protocol: "magpie-mcp",
  baseUrl: "https://example.com",
  modelId: "image-model",
  role: "提取师",
  systemPrompt: "只做提取",
  outputRequirements: "每张原图各出一张",
};

const COLLECTION: CollectionContext = {
  id: "collection-1",
  platform: "小红书",
  sourceTitle: "原始标题",
  sourceBody: null,
  assets: [
    { id: "asset-1", fileName: "a.png", mimeType: "image/png" },
    { id: "asset-2", fileName: "b.png", mimeType: "image/png" },
  ],
};

function run(overrides: Partial<ExtractionRunRecord> = {}): ExtractionRunRecord {
  return {
    id: "run-1",
    collectionId: "collection-1",
    status: "queued",
    requirement: "faithful",
    categories: ["material", "border"],
    sourceAssetIds: ["asset-1", "asset-2"],
    progress: { done: 0, total: 4 },
    error: null,
    extraPrompt: null,
    createdAt: new Date("2026-11-21T00:00:00Z"),
    finishedAt: null,
    ...overrides,
  };
}

interface Harness {
  store: ExtractionStore;
  files: LibraryWriter;
  saved: LibraryAssetInput[][];
  finished: Array<{ status: string; error: unknown }>;
}

/** 内存 store：只记状态变化，不碰数据库。 */
function harness(claimed: ExtractionRunRecord | null): Harness {
  const saved: LibraryAssetInput[][] = [];
  const finished: Array<{ status: string; error: unknown }> = [];
  const store: ExtractionStore = {
    claimNextRun: vi.fn(async () =>
      claimed ? ({ ...claimed, status: "running" } satisfies ExtractionRunRecord) : null,
    ),
    updateRunProgress: vi.fn(async () => 1),
    finishRun: vi.fn(async (_id, status, error) => {
      finished.push({ status, error });
      return 1;
    }),
    failRunningRuns: vi.fn(async () => 0),
    saveAssets: vi.fn(async (_runId, _collectionId, assets) => {
      saved.push([...assets]);
    }),
  };
  const files: LibraryWriter = {
    write: vi.fn(async (_runId, images: readonly ExtractedImage[]) =>
      images.map((image, index) => ({
        storageKey: `library-assets/run-1/${index}.png`,
        fileName: image.fileName ?? `${index}.png`,
        mimeType: image.mimeType,
        width: image.width ?? null,
        height: image.height ?? null,
        category: image.category,
        sourceAssetId: image.sourceAssetId,
        sortOrder: image.sortOrder,
      })),
    ),
  };
  return { store, files, saved, finished };
}

function image(sourceAssetId: string, category: string, sortOrder: number): ExtractedImage {
  return {
    bytes: Buffer.from("png"),
    mimeType: "image/png",
    category,
    sourceAssetId,
    sortOrder,
  };
}

function makeRunner(parts: Harness, handler: ExtractionHandler) {
  return createExtractionRunner({
    store: parts.store,
    files: parts.files,
    handler,
    loadCollection: async () => COLLECTION,
    loadSourceImage: async () => ({ bytes: Buffer.from("src"), mimeType: "image/png" }),
    loadAgent: async () => AGENT,
  });
}

describe("提取运行执行器", () => {
  it("没有排队运行时不做任何事", async () => {
    const parts = harness(null);
    const runner = makeRunner(parts, { run: vi.fn() });

    expect(await runner.runOnce()).toEqual({ ran: false });
    expect(parts.store.finishRun).not.toHaveBeenCalled();
  });

  it("全部成功：素材入库，运行记 succeeded，进度清空", async () => {
    const parts = harness(run());
    const runner = makeRunner(parts, {
      run: async (context) => {
        await context.reportProgress({ done: 4, total: 4 });
        return {
          images: [
            image("asset-1", "material", 1),
            image("asset-1", "border", 1),
            image("asset-2", "material", 2),
            image("asset-2", "border", 2),
          ],
          failures: [],
        };
      },
    });

    expect(await runner.runOnce()).toEqual({ ran: true, runId: "run-1", status: "succeeded" });
    // 4 条素材（2 张原图 × 2 个类别）一次入库，各带来源原图与类别（AC-LIB-1）。
    expect(parts.saved).toHaveLength(1);
    expect(parts.saved[0]).toHaveLength(4);
    expect(parts.saved[0]?.map((asset) => asset.category).sort()).toEqual([
      "border",
      "border",
      "material",
      "material",
    ]);
    expect(parts.store.updateRunProgress).toHaveBeenCalledWith("run-1", { done: 4, total: 4 });
    expect(parts.finished).toEqual([{ status: "succeeded", error: null }]);
  });

  it("一项失败：其余照常入库，运行记 partial 并逐项点名失败原因（AC-LIB-2）", async () => {
    const parts = harness(run());
    const runner = makeRunner(parts, {
      run: async () => ({
        images: [image("asset-1", "material", 1), image("asset-2", "border", 2)],
        failures: [
          {
            category: "border",
            sourceAssetId: "asset-1",
            fileName: "a.png",
            code: "UPSTREAM_REJECTED",
            message: "边框太小",
          },
        ],
      }),
    });

    expect(await runner.runOnce()).toEqual({ ran: true, runId: "run-1", status: "partial" });
    expect(parts.saved[0]).toHaveLength(2);
    const finished = parts.finished[0];
    expect(finished?.status).toBe("partial");
    const error = finished?.error as { code: string; message: string; failures: unknown[] };
    expect(error.code).toBe(EXTRACTION_ERROR_CODES.partial);
    expect(error.message).toContain("a.png");
    expect(error.message).toContain("已保留 2/3 条素材");
    expect(error.failures).toHaveLength(1);
  });

  it("全部失败：不写任何素材，运行记 failed 并说明没有入库", async () => {
    const parts = harness(run());
    const runner = makeRunner(parts, {
      run: async () => ({
        images: [],
        failures: [
          {
            category: "material",
            sourceAssetId: "asset-1",
            fileName: "a.png",
            code: "UPSTREAM_AUTH",
            message: "密钥不可用",
          },
          {
            category: "border",
            sourceAssetId: "asset-2",
            fileName: "b.png",
            code: "UPSTREAM_AUTH",
            message: "密钥不可用",
          },
        ],
      }),
    });

    expect(await runner.runOnce()).toEqual({ ran: true, runId: "run-1", status: "failed" });
    expect(parts.saved).toHaveLength(0);
    const error = parts.finished[0]?.error as { code: string; message: string; failures: unknown[] };
    expect(error.code).toBe("UPSTREAM_AUTH");
    expect(error.message).toContain("没有素材入库");
    expect(error.failures).toHaveLength(2);
  });

  it("处理器抛错：运行记 failed，错误码取自处理器", async () => {
    const parts = harness(run());
    const runner = makeRunner(parts, {
      run: async () => {
        throw new Error("上游连不上");
      },
    });

    expect(await runner.runOnce()).toEqual({ ran: true, runId: "run-1", status: "failed" });
    expect(parts.finished[0]?.status).toBe("failed");
    expect((parts.finished[0]?.error as { code: string }).code).toBe(
      EXTRACTION_ERROR_CODES.jobFailed,
    );
  });

  it("读不到资源夹：错误码是 COLLECTION_MISSING，不再调处理器", async () => {
    const parts = harness(run());
    const handler = { run: vi.fn() };
    const runner = createExtractionRunner({
      store: parts.store,
      files: parts.files,
      handler,
      loadCollection: async () => {
        const { AppError } = await import("@/lib/errors");
        throw AppError.notFound("资源夹不存在");
      },
      loadSourceImage: async () => ({ bytes: Buffer.from(""), mimeType: "image/png" }),
      loadAgent: async () => AGENT,
    });

    await runner.runOnce();
    expect(handler.run).not.toHaveBeenCalled();
    expect((parts.finished[0]?.error as { code: string }).code).toBe(
      EXTRACTION_ERROR_CODES.collectionMissing,
    );
  });

  it("启动清理把残留 running 记为失败", async () => {
    const parts = harness(null);
    vi.mocked(parts.store.failRunningRuns).mockResolvedValue(2);
    const runner = makeRunner(parts, { run: vi.fn() });

    expect(await runner.recover()).toBe(2);
    const [record] = vi.mocked(parts.store.failRunningRuns).mock.calls[0] ?? [];
    expect(record?.code).toBe(EXTRACTION_ERROR_CODES.serverRestarted);
  });

  it("每次运行只写一次终态", async () => {
    const parts = harness(run());
    const runner = makeRunner(parts, {
      run: async () => ({
        images: [image("asset-1", "material", 1)],
        failures: [
          { category: "border", sourceAssetId: "asset-1", fileName: "a.png", code: "X", message: "y" },
        ],
      }),
    });

    await runner.runOnce();
    expect(parts.finished).toHaveLength(1);
    expect(parts.finished[0]?.status).toBe("partial");
  });

  it("写库失败不得把运行说成成功", async () => {
    const parts = harness(run());
    vi.mocked(parts.store.saveAssets).mockRejectedValue(new Error("数据库断了"));
    const runner = makeRunner(parts, {
      run: async () => ({ images: [image("asset-1", "material", 1)], failures: [] }),
    });

    expect(await runner.runOnce()).toEqual({ ran: true, runId: "run-1", status: "failed" });
  });
});
