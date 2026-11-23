// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryAssetView, LibraryView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";
import { LibraryPanel } from "./library-panel";

/**
 * 素材库的批量删除（MKACG-939 评审阻断点）：删除中途失败时界面必须与服务器状态一致
 * —— 已删掉的条目消失、失效的 id 不再留在选择里、失败原因可见，剩下的素材还能重试。
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const COLLECTION: CollectionDetailView = {
  id: "collection-1",
  name: "测试资源夹",
  platform: null,
  sourceUrl: null,
  sourceTitle: null,
  sourceBody: null,
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
  status: "has_results",
  assetCount: 1,
  extractionRunCount: 1,
  libraryAssetCount: 2,
  copyVersionCount: 0,
  coverUrl: null,
  assets: [
    {
      id: "asset-1",
      fileName: "a.png",
      mimeType: "image/png",
      size: 100,
      sortOrder: 1,
      url: "/api/files/collection-1/asset-1",
      thumbnailUrl: "/api/files/collection-1/asset-1?w=400",
    },
  ],
};

function libraryAsset(id: string): LibraryAssetView {
  return {
    id,
    collectionId: COLLECTION.id,
    extractionRunId: "run-1",
    category: "topdown",
    categoryLabel: "桌面俯视图",
    sourceAssetId: "asset-1",
    sourceAssetIndex: 1,
    fileName: `${id}.png`,
    mimeType: "image/png",
    width: 1536,
    height: 1024,
    url: `/api/files/library/${id}`,
    thumbnailUrl: `/api/files/library/${id}?w=400`,
    createdAt: "2026-11-21T00:00:00.000Z",
  };
}

function library(): LibraryView {
  return {
    total: 2,
    groups: [
      {
        category: "topdown",
        label: "桌面俯视图",
        items: [libraryAsset("lib-1"), libraryAsset("lib-2")],
        skipped: [],
      },
    ],
  };
}

/** 只实现 `fetchJson` 用到的那三个成员：`ok` / `status` / `json()`。 */
function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function selectBothAndConfirm(): void {
  fireEvent.click(screen.getByLabelText("选择这条素材：lib-1.png"));
  fireEvent.click(screen.getByLabelText("选择这条素材：lib-2.png"));
  fireEvent.click(screen.getByTestId("library-delete"));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
}

describe("素材库「删除选中」", () => {
  it("全部成功：逐条删除后刷新素材库并清空选择", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetchMock);
    const onLibraryChanged = vi.fn(async () => {});

    render(
      <LibraryPanel
        collection={COLLECTION}
        library={library()}
        onLibraryChanged={onLibraryChanged}
      />,
    );
    selectBothAndConfirm();

    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/已选素材 0/)).toBeTruthy();
  });

  it("中途失败：仍然刷新素材库、清空选择并展示原因，剩下的素材可以重试", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: null }))
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "素材不存在" } }, 404),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onLibraryChanged = vi.fn(async () => {});

    render(
      <LibraryPanel
        collection={COLLECTION}
        library={library()}
        onLibraryChanged={onLibraryChanged}
      />,
    );
    selectBothAndConfirm();

    // 关键断言：失败也要重新拉取素材库（已删的条目才会消失），并清空选择。
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已选素材 0/)).toBeTruthy();
    // 失败原因可见，确认弹窗已关闭，用户可以重新勾选剩下的素材再删。
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("素材不存在");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
