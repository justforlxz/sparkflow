// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastOptions } from "./Toast";

/**
 * 带「撤销」的轻提示（MKACG-1006 AC-DEL2-3）：撤销窗口内点撤销 = 取消待提交的动作，
 * 窗口结束才调用 `onExpire`。删除素材就靠这个把「真的删了」推迟到用户没有反悔之后，
 * 不需要服务端保留「已删除」的中间状态。
 */
function Probe({ message, options }: { message: string; options?: ToastOptions }) {
  const toast = useToast();
  return (
    <button
      type="button"
      data-testid="toast-probe"
      onClick={() => toast.show(message, options)}
    >
      显示提示
    </button>
  );
}

/** 在 `<ToastProvider>` 里挂一个按钮：点它等于业务代码调用 `toast.show`。 */
function showToast(message: string, options?: ToastOptions): void {
  render(
    <ToastProvider>
      <Probe message={message} options={options} />
    </ToastProvider>,
  );
  act(() => {
    screen.getByTestId("toast-probe").click();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast 的撤销窗口", () => {
  it("AC-DEL2-3 点撤销：提示消失，待提交的动作不执行", () => {
    const onAction = vi.fn();
    const onExpire = vi.fn();
    showToast("已删除 1 条素材", {
      tone: "success",
      action: { label: "撤销", onAction, onExpire },
    });

    expect(screen.getByTestId("toast").textContent).toContain("已删除 1 条素材");
    expect(screen.getByTestId("toast-action").textContent).toBe("撤销");

    act(() => {
      screen.getByTestId("toast-action").click();
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast")).toBeNull();

    // 撤销之后又过了很久：提交动作仍然不能执行。
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("AC-DEL2-3 什么都不点：撤销窗口结束后才执行待提交的动作", () => {
    const onExpire = vi.fn();
    showToast("已删除 1 条素材", {
      action: { label: "撤销", onAction: vi.fn(), onExpire },
    });

    // 窗口内（4 秒）还没提交：这一段时间用户都还能撤销。
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(onExpire).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("没有操作的提示不渲染按钮，按普通提示的时间消失", () => {
    showToast("素材库刷新失败", { tone: "danger" });

    expect(screen.queryByTestId("toast-action")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});
