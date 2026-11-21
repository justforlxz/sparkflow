import { describe, expect, it } from "vitest";
import type { LibraryAssetRecord } from "@/modules/extraction/types";
import type { CopyVersionRecord } from "./types";
import { toCopyVersionView } from "./view";

function version(overrides: Partial<CopyVersionRecord> = {}): CopyVersionRecord {
  return {
    id: "version-1",
    collectionId: "collection-1",
    versionNo: 3,
    status: "succeeded",
    title: "标题",
    body: "正文",
    tags: ["标签"],
    copyStyle: "story",
    agentSnapshot: {
      agentType: "copy",
      enabled: true,
      name: "文案 Agent",
      gatewayId: "gateway-1",
      protocol: "openai-chat",
      baseUrl: "https://example.com",
      modelId: "text-model",
      role: "写手",
      systemPrompt: "写文案",
      outputRequirements: "只输出 JSON",
    },
    selectedAssetIds: ["asset-1", "asset-2"],
    extraPrompt: null,
    error: null,
    meta: { visualExtraction: "done" },
    createdAt: new Date("2026-11-21T00:00:00Z"),
    finishedAt: new Date("2026-11-21T00:01:00Z"),
    ...overrides,
  };
}

function asset(id: string): LibraryAssetRecord {
  return {
    id,
    collectionId: "collection-1",
    extractionRunId: "run-1",
    sourceAssetId: "source-1",
    category: "material",
    storageKey: `library-assets/run-1/${id}.png`,
    fileName: `${id}.png`,
    mimeType: "image/png",
    width: 1024,
    height: 1536,
    sortOrder: 1,
    createdAt: new Date("2026-11-21T00:00:00Z"),
  };
}

describe("文案版本视图（docs/prd/12 MUST 4、MUST 5）", () => {
  it("版本号给出 v 标签与三段文案", () => {
    const view = toCopyVersionView(version(), [asset("asset-1"), asset("asset-2")]);
    expect(view.versionLabel).toBe("v3");
    expect(view.title).toBe("标题");
    expect(view.assets.map((item) => item.id)).toEqual(["asset-1", "asset-2"]);
    expect(view.assets.every((item) => !item.deleted)).toBe(true);
  });

  it("素材被删除后版本仍能打开，被删的那一项是占位而不是消失（AC-LIB-6）", () => {
    const view = toCopyVersionView(version(), [asset("asset-2")]);
    expect(view.selectedAssetIds).toEqual(["asset-1", "asset-2"]);
    expect(view.assets).toHaveLength(2);
    expect(view.assets[0]).toMatchObject({
      id: "asset-1",
      deleted: true,
      categoryLabel: "已删除素材",
      url: null,
    });
    expect(view.assets[1]?.deleted).toBe(false);
  });

  it("视觉提取降级时给出两句不同的可操作提示（docs/prd/06）", () => {
    const noGateway = toCopyVersionView(
      version({ meta: { visualExtraction: "skipped-no-vision-gateway" } }),
      [],
    );
    expect(noGateway.copyVisualDegraded).toBe(true);
    expect(noGateway.copyVisualDegradedHint).toContain("magpie-vision");

    const failed = toCopyVersionView(
      version({ meta: { visualExtraction: "skipped-vision-failed" } }),
      [],
    );
    expect(failed.copyVisualDegradedHint).toContain("重新生成");

    const done = toCopyVersionView(version(), []);
    expect(done.copyVisualDegraded).toBe(false);
    expect(done.copyVisualDegradedHint).toBeNull();
  });

  it("失败版本给出可读原因，文案三段为空", () => {
    const view = toCopyVersionView(
      version({
        status: "failed",
        title: null,
        body: null,
        tags: [],
        error: { code: "COPY_FORMAT", message: "回包不是 JSON", at: "2026-11-21T00:00:00Z" },
      }),
      [],
    );
    expect(view.statusLabel).toBe("失败");
    expect(view.error?.code).toBe("COPY_FORMAT");
    expect(view.title).toBeNull();
  });
});
