import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { COPY_JOB_ERROR_CODES } from "./constants";
import { createCopyRunner, type CopyStore } from "./runner";
import type { CopyContext, CopyContent, CopyHandler, CopyVersionRecord, SelectedAssetRef } from "./types";

const AGENT: AgentSnapshot = {
  agentType: "copy",
  enabled: true,
  name: "文案创作 Agent",
  gatewayId: "gateway-1",
  protocol: "openai-chat",
  baseUrl: "https://example.com",
  modelId: "text-model",
  role: "写手",
  systemPrompt: "写文案",
  outputRequirements: "只输出 JSON",
};

function version(overrides: Partial<CopyVersionRecord> = {}): CopyVersionRecord {
  return {
    id: "version-1",
    collectionId: "collection-1",
    versionNo: 2,
    status: "queued",
    title: null,
    body: null,
    tags: [],
    copyStyle: "story",
    agentSnapshot: AGENT,
    selectedAssetIds: ["asset-1", "asset-2"],
    extraPrompt: null,
    error: null,
    meta: null,
    createdAt: new Date("2026-11-21T00:00:00Z"),
    finishedAt: null,
    ...overrides,
  };
}

const ASSETS: SelectedAssetRef[] = [
  { id: "asset-1", category: "material", fileName: "a.png", mimeType: "image/png" },
  { id: "asset-2", category: "border", fileName: "b.png", mimeType: "image/png" },
];

interface Harness {
  store: CopyStore;
  succeeded: CopyContent[];
  failed: Array<{ code: string }>;
}

function harness(claimed: CopyVersionRecord | null): Harness {
  const succeeded: CopyContent[] = [];
  const failed: Array<{ code: string }> = [];
  const store: CopyStore = {
    claimNextVersion: vi.fn(async () =>
      claimed ? ({ ...claimed, status: "running" } satisfies CopyVersionRecord) : null,
    ),
    markVersionSucceeded: vi.fn(async (_id, copy) => {
      succeeded.push(copy);
      return 1;
    }),
    markVersionFailed: vi.fn(async (_id, error) => {
      failed.push({ code: error.code });
      return 1;
    }),
    failRunningVersions: vi.fn(async () => 0),
  };
  return { store, succeeded, failed };
}

function makeRunner(parts: Harness, handler: CopyHandler) {
  return createCopyRunner({
    store: parts.store,
    handler,
    loadCollection: async () => ({
      id: "collection-1",
      platform: "小红书",
      sourceTitle: "原始标题",
      sourceBody: null,
    }),
    loadAssets: async () => ASSETS,
    loadAssetImage: async () => ({ bytes: Buffer.from("img"), mimeType: "image/png" }),
  });
}

describe("文案版本执行器（docs/prd/12 MUST 1、MUST 4）", () => {
  it("没有排队版本时不做任何事", async () => {
    const parts = harness(null);
    const runner = makeRunner(parts, { run: vi.fn() });

    expect(await runner.runOnce()).toEqual({ ran: false });
    expect(parts.store.markVersionSucceeded).not.toHaveBeenCalled();
  });

  it("生成成功：写入三段文案，版本记 succeeded", async () => {
    const parts = harness(version());
    const contexts: CopyContext[] = [];
    const handler: CopyHandler = {
      run: async (context) => {
        contexts.push(context);
        return {
          copy: { title: "标题", body: "正文", tags: ["标签"] },
          meta: { visualExtraction: "done" },
        };
      },
    };
    const runner = makeRunner(parts, handler);

    expect(await runner.runOnce()).toEqual({ ran: true, versionId: "version-1", status: "succeeded" });
    expect(parts.succeeded).toEqual([{ title: "标题", body: "正文", tags: ["标签"] }]);
    // 只读选中的素材，不做任何提取（MUST NOT：跑文案不触发提取）。
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.assets.map((asset) => asset.id)).toEqual(["asset-1", "asset-2"]);
  });

  it("选中的素材都已被删除：不调处理器，版本记 failed 并说明原因", async () => {
    const parts = harness(version());
    const handler = { run: vi.fn() } as unknown as CopyHandler;
    const runner = createCopyRunner({
      store: parts.store,
      handler: handler as never,
      loadCollection: async () => ({
        id: "collection-1",
        platform: null,
        sourceTitle: null,
        sourceBody: null,
      }),
      loadAssets: async () => [],
      loadAssetImage: async () => ({ bytes: Buffer.from(""), mimeType: "image/png" }),
    });

    expect(await runner.runOnce()).toEqual({ ran: true, versionId: "version-1", status: "failed" });
    expect(handler.run).not.toHaveBeenCalled();
    expect(parts.failed[0]?.code).toBe(COPY_JOB_ERROR_CODES.inputMissing);
  });

  it("处理器抛错：版本记 failed，错误分类取自错误码", async () => {
    const parts = harness(version());
    const runner = makeRunner(parts, {
      run: vi.fn(async () => {
        const { StageError } = await import("@/lib/job-failure");
        throw new StageError("COPY_FORMAT", "回包不是 JSON");
      }),
    });

    await runner.runOnce();
    expect(parts.failed[0]?.code).toBe("COPY_FORMAT");
  });

  it("启动清理把残留 running 记为失败", async () => {
    const parts = harness(null);
    vi.mocked(parts.store.failRunningVersions).mockResolvedValue(1);
    const runner = makeRunner(parts, { run: vi.fn() });

    expect(await runner.recover()).toBe(1);
    const [record] = vi.mocked(parts.store.failRunningVersions).mock.calls[0] ?? [];
    expect(record?.code).toBe(COPY_JOB_ERROR_CODES.serverRestarted);
  });
});
