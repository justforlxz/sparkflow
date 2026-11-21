// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { CopyVersionView } from "@/modules/copy-generation/view";
import type { LibraryView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";
import { PublishPanel } from "./publish-panel";

/**
 * 发布页签的草稿保护（MKACG-940 评审阻断点之二）：
 * 轮询会不断把版本列表换成一模一样的新数组，用户正在改的标题 / 正文 / 标签不能被冲掉；
 * 只有这个版本的内容真的变了（保存成功、重新生成），才回到服务端的值。
 *
 * 场景取「当前版本已生成完成、另有一条更早的版本还在生成」：
 * 这是轮询开着而当前版本可编辑的唯一真实状态（正在生成的新版本会成为当前版本，
 * 那时页面显示的是进度而不是输入框）。
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

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
  libraryAssetCount: 1,
  copyVersionCount: 2,
  coverUrl: null,
  assets: [],
};

const LIBRARY: LibraryView = { groups: [], total: 0 };

function baseVersion(overrides: Partial<CopyVersionView> & { id: string }): CopyVersionView {
  return {
    collectionId: COLLECTION.id,
    versionNo: 1,
    versionLabel: "v1",
    status: "succeeded",
    statusLabel: "已完成",
    title: null,
    body: null,
    tags: [],
    copyStyle: "story",
    copyStyleLabel: "故事分享",
    selectedAssetIds: [],
    assets: [],
    extraPrompt: null,
    error: null,
    copyVisualDegraded: false,
    copyVisualDegradedHint: null,
    createdAt: "2026-11-21T00:00:00.000Z",
    finishedAt: "2026-11-21T00:01:00.000Z",
    ...overrides,
  };
}

const CURRENT = baseVersion({
  id: "version-2",
  versionNo: 2,
  versionLabel: "v2",
  title: "服务端标题",
  body: "服务端正文",
  tags: ["服务端"],
});

/** 更早的一版还在生成：列表不是空，轮询保持开启。 */
const OLDER_RUNNING = baseVersion({
  id: "version-1",
  status: "running",
  statusLabel: "生成中",
  finishedAt: null,
});

/** 只实现 `fetchJson` 用到的那三个成员：`ok` / `status` / `json()`。 */
function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/** 输入框当前值（仓库没有引入 jest-dom 的 `toHaveValue`，直接读 DOM 属性）。 */
function fieldValue(testId: string): string {
  const element = screen.getByTestId(testId) as HTMLInputElement | HTMLTextAreaElement;
  return element.value;
}

describe("发布页签的草稿保护", () => {
  it(
    "轮询换回同样的内容时不覆盖正在编辑的三段；内容真的变了才回到服务端值",
    async () => {
      let versions: CopyVersionView[] = [CURRENT, OLDER_RUNNING];
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/publish-records")) {
          return jsonResponse({ ok: true, data: { items: [], total: 0 } });
        }
        if (url.includes("/copy-versions")) {
          // 每次都是新对象：模拟真实接口返回，确保 React 状态确实被替换过一遍。
          return jsonResponse({
            ok: true,
            data: { versions: versions.map((version) => ({ ...version })) },
          });
        }
        throw new Error(`未预期的请求：${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      render(
        <ToastProvider>
          <PublishPanel collection={COLLECTION} library={LIBRARY} />
        </ToastProvider>,
      );

      // 当前版本（v2）可编辑；更早的 v1 在生成中，轮询已开启。
      const title = await screen.findByTestId("publish-title");
      expect(fieldValue("publish-title")).toBe("服务端标题");
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      fireEvent.change(title, { target: { value: "我在改" } });
      expect(fieldValue("publish-title")).toBe("我在改");

      // 第一次轮询：服务端内容没变，用户输入必须保留。
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 8_000 });
      expect(fieldValue("publish-title")).toBe("我在改");

      // 服务端内容真的变了：草稿回到服务端值（保存成功后的同一路径）。
      versions = [baseVersion({ ...CURRENT, title: "服务端新标题" }), OLDER_RUNNING];
      await waitFor(() => expect(fieldValue("publish-title")).toBe("服务端新标题"), {
        timeout: 8_000,
      });
    },
    30_000,
  );
});