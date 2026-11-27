// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { ResultCardView, ResultCellView } from "@/modules/extraction/results";
import { ResultCards, type ResultSelectionProps } from "./result-cards";

/**
 * 结果卡的 DOM 契约：格子上的「含水印」角标（MKACG-1004、AC-WM-3）与删除入口（MKACG-1006）。
 *
 * 这里只锁可见文字、无障碍名称、可用态与回调参数。**真实命中**（鼠标移上去拿到的是角标自己
 * 而不是下面那张缩略图）需要布局与命中测试，jsdom 没有，由 `tests/e2e/library.spec.ts` 的
 * AC-WM-3 用例在真实 Chromium 里断言 —— 上一版正是在这里只断言了 title 属性，把
 * 「角标 pointer-events-none、title 永远不显示」掩盖成了通过。
 * 删除的实际效果（请求时机、撤销、原图不动）在 `tests/e2e/library-delete.spec.ts` 里断言，
 * 这里只锁「点了哪个格子、传的是哪条素材」。
 */
afterEach(cleanup);

function doneCell(watermarkRemoved: boolean, watermarkNote: string | null): ResultCellView {
  return {
    category: "topdown",
    label: "桌面俯视图",
    state: "done",
    asset: {
      id: "library-1",
      fileName: "1.png",
      url: "/api/files/library/library-1",
      thumbnailUrl: "/api/files/library/library-1?w=400",
      watermarkRemoved,
      watermarkNote,
      source: "model",
      sourceLabel: "模型提取（可能重画）",
    },
    reason: null,
    retry: null,
  };
}

function idleCell(): ResultCellView {
  return {
    category: "texture",
    label: "基本纹理",
    state: "idle",
    asset: null,
    reason: null,
    retry: null,
  };
}

function card(cells: ResultCellView[]): ResultCardView {
  return {
    sourceAssetId: "asset-1",
    fileName: "asset-1.png",
    thumbnailUrl: "/api/files/media/asset-1",
    quadKind: null,
    cells,
    done: cells.filter((cell) => cell.state === "done").length,
    total: cells.length,
    requirement: "faithful",
  };
}

function selection(overrides: Partial<ResultSelectionProps> = {}): ResultSelectionProps {
  return {
    selected: new Set<string>(),
    staleCount: 0,
    onToggle: () => undefined,
    onClear: () => undefined,
    onDeleteSelected: () => undefined,
    onDeleteOne: () => undefined,
    onKeepLatest: () => undefined,
    ...overrides,
  };
}

function renderCells(cells: ResultCellView[], selectionProps: ResultSelectionProps = selection()) {
  render(
    <ResultCards
      cards={[card(cells)]}
      retrying={new Set<string>()}
      onRetry={() => undefined}
      onRerun={() => undefined}
      selection={selectionProps}
    />,
  );
}

describe("AC-WM-3 结果格上的「含水印」角标", () => {
  it("AC-WM-3 没去掉水印的产物：可见文字是「含水印」，title 与 aria-label 都带原因，且可聚焦", () => {
    const note = "未去水印：底部 10% 条带里主体像素占 80.0%，裁掉会切掉主体，已保留原图";
    renderCells([doneCell(false, note)]);

    const badge = screen.getByTestId("library-watermark-badge");
    expect(badge.textContent).toBe(LIBRARY_COPY.watermarkBadge);
    // 鼠标：title 是原因的出口（前提是角标自己能被指到，e2e 断言）。
    expect(badge.getAttribute("title")).toBe(note);
    // 键盘与读屏：角标可聚焦，无障碍名称里带原因。
    expect(badge.getAttribute("aria-label")).toBe(`${LIBRARY_COPY.watermarkBadge}：${note}`);
    expect(badge.getAttribute("tabindex")).toBe("0");
  });

  it("AC-WM-3 已经去掉水印的产物：不显示角标", () => {
    renderCells([doneCell(true, null)]);

    expect(screen.queryByTestId("library-watermark-badge")).toBeNull();
  });
});

describe("AC-DEL2-1 结果格上的逐条删除入口", () => {
  it("AC-DEL2-1 完成的格子上有删除按钮，无障碍名称带文件名，点了回调带这条素材 id", () => {
    const onDeleteOne = vi.fn();
    renderCells([doneCell(true, null), idleCell()], selection({ onDeleteOne }));

    const button = screen.getByTestId("result-cell-delete");
    expect(button.getAttribute("aria-label")).toBe(`${LIBRARY_COPY.deleteAssetLabel}：1.png`);
    expect(button.getAttribute("title")).toBe(LIBRARY_COPY.deleteAssetAction);

    button.click();
    expect(onDeleteOne).toHaveBeenCalledWith("library-1");
  });

  it("AC-DEL2-1 没有产物的格子（未提取）上没有删除按钮", () => {
    renderCells([idleCell()]);

    expect(screen.queryByTestId("result-cell-delete")).toBeNull();
  });
});

describe("AC-DEL2-2 批量删除的勾选与标题栏", () => {
  it("AC-DEL2-2 完成的格子上有勾选框，勾上后标题栏计数与「删除选中」可用，点了回调带勾选集合", () => {
    const onToggle = vi.fn();
    const onDeleteSelected = vi.fn();
    renderCells([doneCell(true, null)], selection({ onToggle, onDeleteSelected }));

    // 没勾选时：计数为 0，批量删除不可点。
    expect(screen.getByTestId("result-selection-count").textContent).toBe(
      `${LIBRARY_COPY.selectedLibraryLabel} 0 ${LIBRARY_COPY.itemCountSuffix}`,
    );
    expect(screen.getByTestId("result-delete-selected")).toHaveProperty("disabled", true);

    const checkbox = screen.getByTestId("result-cell-select") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-label")).toBe(
      `${LIBRARY_COPY.librarySelectLabel}：1.png`,
    );
    checkbox.click();
    expect(onToggle).toHaveBeenCalledWith("library-1");
  });

  it("AC-DEL2-2 勾选中的素材标在标题栏计数上，批量删除这时可点并回调", () => {
    const onDeleteSelected = vi.fn();
    renderCells(
      [doneCell(true, null)],
      selection({ selected: new Set(["library-1"]), onDeleteSelected }),
    );

    expect(screen.getByTestId("result-selection-count").textContent).toBe(
      `${LIBRARY_COPY.selectedLibraryLabel} 1 ${LIBRARY_COPY.itemCountSuffix}`,
    );
    expect(screen.getByTestId("result-delete-selected")).toHaveProperty("disabled", false);
    expect((screen.getByTestId("result-cell-select") as HTMLInputElement).checked).toBe(true);
    screen.getByTestId("result-delete-selected").click();
    expect(onDeleteSelected).toHaveBeenCalled();
  });
});

describe("「只保留最新」的可用条件", () => {
  it("没有重复产物时按钮不可点，有重复时可点并回调", () => {
    const onKeepLatest = vi.fn();
    renderCells([doneCell(true, null)], selection({ staleCount: 0 }));
    expect(screen.getByTestId("result-keep-latest")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("result-keep-latest").textContent).toBe(
      LIBRARY_COPY.keepLatestAction,
    );

    cleanup();
    renderCells([doneCell(true, null)], selection({ staleCount: 1, onKeepLatest }));
    screen.getByTestId("result-keep-latest").click();
    expect(onKeepLatest).toHaveBeenCalled();
  });
});
