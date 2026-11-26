"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 全局轻提示（docs/prd/09-dashboard.md MUST 4、SHOULD「全局错误提示统一走 toast」）。
 *
 * 用法：外壳里包一层 `<ToastProvider>`，交互组件里 `const toast = useToast()` 后调用
 * `toast.show(message)`。文案只用后端 `error.message`，不拼接技术细节。
 * 没有提示时容器不渲染任何节点，页面上不会常驻一个 `role="status"`。
 * 三种色调与 `ErrorState` / 提示条同一套设计变量，不另造颜色。
 *
 * 需要「撤销」的操作传 `options.action`：提示里多一个操作按钮，停留时间延长到
 * `TOAST_ACTION_DURATION_MS`（撤销窗口）。**真正的动作放在 `onExpire` 里**，窗口结束才提交，
 * 点撤销只是取消它 —— 这样撤销不需要服务端保留「已删除」的中间状态（MKACG-1006）。
 */
const TOAST_DURATION_MS = 4000;

/** 带操作的提示停留时间：这就是撤销窗口，5 秒内都能反悔。 */
const TOAST_ACTION_DURATION_MS = 5000;

export type ToastTone = "info" | "success" | "danger";

export interface ToastAction {
  /** 操作按钮上的文字（「撤销」）。 */
  label: string;
  /** 用户点了操作按钮：调用方在这里取消待提交的动作。 */
  onAction(): void;
  /** 提示自动消失（撤销窗口结束）：调用方在这里提交真正的动作。 */
  onExpire?(): void;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action: ToastAction | null;
}

const TOAST_TONE_CLASS: Record<ToastTone, string> = {
  info: "border-line bg-panel text-ink",
  success: "border-positive/25 bg-positive-soft text-positive",
  danger: "border-danger/25 bg-danger-soft text-danger",
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  // 自增序号只用作 key 与关闭定位，不进渲染结果，因此不受渲染次数影响。
  const nextId = useRef(0);
  // 每条提示的定时器：撤销窗口结束时提交动作，卸载时清掉，不回调已经不在的界面。
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback((message: string, options: ToastOptions = {}) => {
    const id = nextId.current + 1;
    nextId.current = id;
    const action = options.action ?? null;
    setItems((current) => [...current, { id, message, tone: options.tone ?? "info", action }]);

    const duration = action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS;
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setItems((current) => current.filter((item) => item.id !== id));
        action?.onExpire?.();
      }, duration),
    );
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {items.length > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4">
          {items.map((item) => (
            <div
              key={item.id}
              role="status"
              data-testid="toast"
              className={[
                "pointer-events-auto flex max-w-md items-center gap-3 rounded-md border px-4 py-2 text-body shadow-panel",
                TOAST_TONE_CLASS[item.tone],
              ].join(" ")}
            >
              <span>{item.message}</span>
              {item.action ? (
                <button
                  type="button"
                  data-testid="toast-action"
                  onClick={() => {
                    const action = item.action;
                    dismiss(item.id);
                    action?.onAction();
                  }}
                  className="shrink-0 rounded-sm font-medium underline underline-offset-2"
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return api;
}
