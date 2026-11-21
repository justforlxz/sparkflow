// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import { CREATION_EXPANDED_STORAGE_KEY } from "@/modules/generation/creation";
import type { ResultView, StageView, TaskSummaryView } from "@/modules/generation/view";
import { CreationPanel } from "./creation-panel";

/**
 * 资源夹详情「创作」区的渲染（MKACG-916，docs/prd/07「资源夹详情的「创作」区」）。
 *
 * 这里锁的是「给定服务端数据，界面该显示什么」：两个阶段与生图进度、失败原因与重试入口、
 * 结果默认折叠与展开后的内容、空状态引导。请求、轮询、路由刷新由 e2e 覆盖。
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function stageView(overrides: Partial<StageView> & Pick<StageView, "stage">): StageView {
  return {
    label: overrides.stage === "image" ? "生图阶段" : "文案阶段",
    status: "succeeded",
    statusLabel: "已完成",
    attempts: 1,
    error: null,
    startedAt: null,
    finishedAt: null,
    progress: null,
    ...overrides,
  };
}

function taskView(
  overrides: Partial<TaskSummaryView> & Pick<TaskSummaryView, "id" | "status">,
): TaskSummaryView {
  return {
    collectionId: "collection-1",
    collectionName: "资源夹一",
    statusLabel: "执行中",
    extractRequirement: "faithful",
    extractRequirementLabel: "忠实还原",
    extractTarget: "桌垫的织物纹理",
    copyStyle: "story",
    copyStyleLabel: "故事",
    expectedImageCount: 2,
    extraPrompt: null,
    createdAt: "2026-11-20T08:30:00.000Z",
    stages: {
      image: stageView({ stage: "image" }),
      copy: stageView({ stage: "copy" }),
    },
    retryHint: null,
    ...overrides,
  };
}

function resultView(overrides: Partial<ResultView> = {}): ResultView {
  return {
    id: "result-1",
    taskId: "task-1",
    collectionId: "collection-1",
    title: "标题一句话",
    body: "正文一段话",
    tags: ["旅行", "咖啡"],
    visualStyle: "fresh",
    visualStyleLabel: "清爽",
    extractTarget: "桌垫的织物纹理",
    createdAt: "2026-11-20T08:40:00.000Z",
    copyFailed: false,
    copyVisualDegraded: false,
    copyVisualDegradedHint: null,
    assets: [
      {
        id: "asset-1",
        fileName: "a.png",
        mimeType: "image/png",
        sortOrder: 1,
        url: "/api/files/generated/result-1/asset-1",
        thumbnailUrl: "/api/files/generated/result-1/asset-1?w=400",
        sourceAssetId: "source-1",
      },
      {
        id: "asset-2",
        fileName: "b.png",
        mimeType: "image/png",
        sortOrder: 2,
        url: "/api/files/generated/result-1/asset-2",
        thumbnailUrl: "/api/files/generated/result-1/asset-2?w=400",
        sourceAssetId: "source-2",
      },
    ],
    ...overrides,
  };
}

function renderPanel(input: {
  tasks?: TaskSummaryView[];
  results?: ResultView[];
  publishedResultIds?: string[];
}) {
  render(
    <ToastProvider>
      <CreationPanel
        collectionId="collection-1"
        initialTasks={input.tasks ?? []}
        results={input.results ?? []}
        publishedResultIds={input.publishedResultIds ?? []}
        sourceAssetIds={["source-1", "source-2"]}
        shareEntry={null}
      />
    </ToastProvider>,
  );
}

describe("AC-C-1 进行中任务在创作区就地显示", () => {
  it("两个阶段各自一个状态，生图阶段显示「第 k/N 张」", () => {
    renderPanel({
      tasks: [
        taskView({
          id: "task-running",
          status: "running",
          stages: {
            image: stageView({
              stage: "image",
              status: "running",
              statusLabel: "执行中",
              progress: { done: 1, total: 2 },
            }),
            copy: stageView({ stage: "copy", status: "queued", statusLabel: "排队中" }),
          },
        }),
      ],
    });

    const card = screen.getByTestId("creation-running-task");
    expect(within(card).getByTestId("creation-stage-image-status").textContent).toBe("执行中");
    expect(within(card).getByTestId("creation-stage-copy-status").textContent).toBe("排队中");
    expect(within(card).getByTestId("creation-stage-image-progress").textContent).toBe(
      "正在生图 第 1/2 张",
    );
  });

  it("没有进度时（文案阶段）不显示进度那一格", () => {
    renderPanel({
      tasks: [
        taskView({
          id: "task-running",
          status: "running",
          stages: {
            image: stageView({ stage: "image", status: "succeeded" }),
            copy: stageView({ stage: "copy", status: "running", statusLabel: "执行中" }),
          },
        }),
      ],
    });

    const card = screen.getByTestId("creation-running-task");
    expect(within(card).queryByTestId("creation-stage-image-progress")).toBeNull();
    expect(within(card).queryByTestId("creation-stage-copy-progress")).toBeNull();
  });
});

describe("AC-C-4 失败/部分失败的任务就地显示原因与重试", () => {
  it("文案阶段失败时给出可读原因与「重试」", () => {
    renderPanel({
      tasks: [
        taskView({
          id: "task-partial",
          status: "partial",
          statusLabel: "部分完成",
          stages: {
            image: stageView({ stage: "image" }),
            copy: stageView({
              stage: "copy",
              status: "failed",
              statusLabel: "失败",
              error: { code: "COPY_FORMAT", message: "mock：文案阶段按脚本失败", at: "2026-11-20T08:30:00.000Z" },
            }),
          },
        }),
      ],
    });

    const card = screen.getByTestId("creation-troubled-task");
    expect(within(card).getByTestId("creation-stage-copy-error").textContent).toContain(
      "mock：文案阶段按脚本失败",
    );
    expect(within(card).getByTestId("creation-retry-button")).toBeTruthy();
  });

  it("只有「部分原图失败」时显示原因，但不给「重试」（没有失败的阶段）", () => {
    renderPanel({
      tasks: [
        taskView({
          id: "task-partial-image",
          status: "partial",
          statusLabel: "部分完成",
          stages: {
            image: stageView({
              stage: "image",
              error: { code: "IMAGE_REJECTED", message: "第 2 张原图被上游拒绝", at: "2026-11-20T08:30:00.000Z" },
            }),
            copy: stageView({ stage: "copy" }),
          },
        }),
      ],
    });

    const card = screen.getByTestId("creation-troubled-task");
    expect(within(card).getByTestId("creation-stage-image-error").textContent).toContain(
      "第 2 张原图被上游拒绝",
    );
    expect(within(card).queryByTestId("creation-retry-button")).toBeNull();
  });
});

describe("AC-C-2 结果默认折叠，展开后才出现文案与按钮", () => {
  it("折叠态只有缩略图与摘要，不露标题正文标签与按钮", () => {
    renderPanel({ results: [resultView()] });

    const card = screen.getByTestId("result-card");
    expect(card.querySelectorAll("img")).toHaveLength(2);
    expect(within(card).getAllByTestId("result-source").map((node) => node.textContent)).toEqual([
      "原图 1",
      "原图 2",
    ]);

    const toggle = within(card).getByTestId("result-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("生成于 2026-11-20");
    expect(toggle.textContent).toContain("2 张");
    expect(toggle.textContent).toContain("未发布");

    expect(within(card).queryByTestId("result-title")).toBeNull();
    expect(within(card).queryByTestId("result-body")).toBeNull();
    expect(within(card).queryByTestId("result-tags")).toBeNull();
    expect(within(card).queryByTestId("edit-result")).toBeNull();
    expect(within(card).queryByTestId("publish-prepare")).toBeNull();
  });

  it("点击展开后出现标题、正文、标签与「编辑」「发布准备」", () => {
    renderPanel({ results: [resultView()] });

    const card = screen.getByTestId("result-card");
    fireEvent.click(within(card).getByTestId("result-toggle"));

    expect(within(card).getByTestId("result-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(within(card).getByTestId("result-title").textContent).toBe("标题一句话");
    expect(within(card).getByTestId("result-body").textContent).toBe("正文一段话");
    expect(within(card).getByTestId("result-tags").textContent).toBe("#旅行 #咖啡");
    expect(within(card).getByTestId("edit-result").textContent).toBe("编辑");
    expect(within(card).getByTestId("publish-prepare").textContent).toBe("发布准备");
  });

  it("水印提示跟着折叠状态换：折叠态一行短文案，展开后是定稿主文案", () => {
    renderPanel({ results: [resultView()] });

    const card = screen.getByTestId("result-card");
    expect(card.querySelector("[data-testid='result-watermark-short-notice']")?.textContent).toBe(
      "该模型可能自带水印，发布前请确认。",
    );
    expect(card.querySelector("[data-testid='result-watermark-notice']")).toBeNull();

    fireEvent.click(within(card).getByTestId("result-toggle"));

    const main = screen.getByTestId("result-watermark-notice").textContent ?? "";
    // 主文案必须说清三件事：图片来源、水印可能来自该模型、不接受时换模型（docs/prd/05 定稿）。
    expect(main).toContain("图片由你在设置里选择的图片模型生成");
    expect(main).toContain("可能自带该模型的水印或角标");
    expect(main).toContain("可在设置里换一个不加水印的模型重新生成");
    for (const forbidden of ["已去除", "保证无水印", "上游模型", "系统已校验", "图片合格"]) {
      expect(main).not.toContain(forbidden);
    }
    expect(card.querySelector("[data-testid='result-watermark-short-notice']")).toBeNull();
  });

  it("已发布的结果在摘要里标成已发布，由服务端给的结果 id 决定", () => {
    renderPanel({ results: [resultView()], publishedResultIds: ["result-1"] });

    expect(screen.getByTestId("result-toggle").textContent).toContain("已发布");
  });

  it("文案阶段失败的结果在摘要里标出失败，不在折叠态露正文", () => {
    renderPanel({ results: [resultView({ copyFailed: true })] });

    const toggle = screen.getByTestId("result-toggle");
    expect(toggle.textContent).toContain("文案阶段失败");
    expect(toggle.textContent).not.toContain("正文一段话");
  });
});

describe("AC-C-3 折叠状态从本地读回", () => {
  it("本地记着展开时，进入页面就是展开的", () => {
    window.localStorage.setItem(CREATION_EXPANDED_STORAGE_KEY, JSON.stringify(["result-1"]));

    renderPanel({ results: [resultView()] });

    expect(screen.getByTestId("result-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("result-title").textContent).toBe("标题一句话");
  });
});

describe("MUST 6 空状态", () => {
  it("没有任务也没有结果时给「开始 AI 创作」引导", () => {
    renderPanel({});

    expect(screen.getByText("这个资源夹还没有开始 AI 创作。")).toBeTruthy();
    expect(screen.getByText(/点「开始 AI 创作」/)).toBeTruthy();
  });

  it("有任务（即使还没有结果）时不显示空状态", () => {
    renderPanel({
      tasks: [taskView({ id: "task-running", status: "running" })],
    });

    expect(screen.queryByText("这个资源夹还没有开始 AI 创作。")).toBeNull();
  });
});

describe("MKACG-933 结果卡：站内图片预览与结果操作", () => {
  it("折叠态的缩略图是站内预览按钮，不是打开新标签页的链接", () => {
    renderPanel({ results: [resultView()] });

    const card = screen.getByTestId("result-card");
    const thumbnails = within(card).getAllByTestId("image-thumbnail");
    expect(thumbnails).toHaveLength(2);
    for (const thumbnail of thumbnails) expect(thumbnail.tagName).toBe("BUTTON");
    expect(card.querySelector('a[target="_blank"]')).toBeNull();
  });

  it("点击缩略图在弹窗里加载原图，并显示文件名", () => {
    renderPanel({ results: [resultView()] });

    const card = screen.getByTestId("result-card");
    fireEvent.click(within(card).getAllByTestId("image-thumbnail")[0]!);

    expect(screen.getByTestId("image-lightbox-image").getAttribute("src")).toBe(
      "/api/files/generated/result-1/asset-1",
    );
    expect(screen.getByTestId("image-lightbox-filename").textContent).toBe("a.png");
  });

  it("「删除」只在展开后出现，点了先出二次确认并说明发布记录一并删除", () => {
    renderPanel({ results: [resultView()] });

    const card = screen.getByTestId("result-card");
    expect(within(card).queryByTestId("delete-result")).toBeNull();

    fireEvent.click(within(card).getByTestId("result-toggle"));
    fireEvent.click(within(card).getByTestId("delete-result"));

    const dialog = screen.getByRole("dialog", { name: "删除这个结果？" });
    expect(dialog.textContent).toContain("该结果的发布记录会一并删除，原始素材不受影响");
  });

  it("文案阶段失败时展开后给出可读提示与重试入口", () => {
    renderPanel({ results: [resultView({ copyFailed: true })] });

    const card = screen.getByTestId("result-card");
    fireEvent.click(within(card).getByTestId("result-toggle"));

    expect(within(card).getByTestId("copy-failed-hint").textContent).toBe(
      "文案阶段失败，可重试或手动补写",
    );
    expect(within(card).getByTestId("copy-retry-button").textContent).toBe("重试文案阶段");
  });

  it("视觉提取降级时展开后标注原因与下一步动作", () => {
    renderPanel({
      results: [
        resultView({
          copyVisualDegraded: true,
          copyVisualDegradedHint: "未配置图片理解网关，文案未包含照片内容；请到设置页添加 magpie-vision 网关",
        }),
      ],
    });

    const card = screen.getByTestId("result-card");
    fireEvent.click(within(card).getByTestId("result-toggle"));

    expect(within(card).getByTestId("copy-visual-degraded").textContent).toContain(
      "请到设置页添加 magpie-vision 网关",
    );
  });
});
