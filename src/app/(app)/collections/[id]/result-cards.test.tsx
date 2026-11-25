// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { ResultCardView, ResultCellView } from "@/modules/extraction/results";
import { ResultCards } from "./result-cards";

/**
 * 结果格的「含水印」角标（MKACG-1004、AC-WM-3）：上游水印没能去掉的产物要在格子上标出来，
 * 原因对鼠标、键盘与读屏用户都要拿得到；去掉了的不标。
 *
 * 这里只锁 DOM 契约（可见文字、title、aria-label、可聚焦）。**真实命中**（鼠标移上去拿到的
 * 是角标自己而不是下面那张缩略图）需要布局与命中测试，jsdom 没有，由 `tests/e2e/library.spec.ts`
 * 的 AC-WM-3 用例在真实 Chromium 里断言 —— 上一版正是在这里只断言了 title 属性，把
 * 「角标 pointer-events-none、title 永远不显示」掩盖成了通过。
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
    },
    reason: null,
    retry: null,
  };
}

function card(cell: ResultCellView): ResultCardView {
  return {
    sourceAssetId: "asset-1",
    fileName: "asset-1.png",
    thumbnailUrl: "/api/files/media/asset-1",
    cells: [cell],
    done: 1,
    total: 1,
    requirement: "faithful",
  };
}

function renderCells(cell: ResultCellView) {
  render(
    <ResultCards
      cards={[card(cell)]}
      retrying={new Set<string>()}
      onRetry={() => undefined}
      onRerun={() => undefined}
    />,
  );
}

describe("AC-WM-3 结果格上的「含水印」角标", () => {
  it("AC-WM-3 没去掉水印的产物：可见文字是「含水印」，title 与 aria-label 都带原因，且可聚焦", () => {
    const note = "未去水印：底部 10% 条带里主体像素占 80.0%，裁掉会切掉主体，已保留原图";
    renderCells(doneCell(false, note));

    const badge = screen.getByTestId("library-watermark-badge");
    expect(badge.textContent).toBe(LIBRARY_COPY.watermarkBadge);
    // 鼠标：title 是原因的出口（前提是角标自己能被指到，e2e 断言）。
    expect(badge.getAttribute("title")).toBe(note);
    // 键盘与读屏：角标可聚焦，无障碍名称里带原因。
    expect(badge.getAttribute("aria-label")).toBe(`${LIBRARY_COPY.watermarkBadge}：${note}`);
    expect(badge.getAttribute("tabindex")).toBe("0");
  });

  it("AC-WM-3 已经去掉水印的产物：不显示角标", () => {
    renderCells(doneCell(true, null));

    expect(screen.queryByTestId("library-watermark-badge")).toBeNull();
  });
});
