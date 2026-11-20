"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 全局轻提示（docs/prd/09-dashboard.md MUST 4、SHOULD「全局错误提示统一走 toast」）。
 *
 * 用法：外壳里包一层 `<ToastProvider>`，交互组件里 `const toast = useToast()` 后调用
 * `toast.show(message)`。文案只用后端 `error.message`，不拼接技术细节。
 * 没有提示时容器不渲染任何节点，页面上不会常驻一个 `role="status"`。
 * 三种色调与 `ErrorState` / 提示条同一套设计变量，不另造颜色。
 */
const TOAST_DURATION_MS = 4000;

export type ToastTone = "info" | "success" | "danger";

export interface ToastApi {
  show(message: string, tone?: ToastTone): void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
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

  const show = useCallback((message: string, tone: ToastTone = "info") => {
    const id = nextId.current + 1;
    nextId.current = id;
    setItems((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, TOAST_DURATION_MS);
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
                "pointer-events-auto max-w-md rounded-md border px-4 py-2 text-body shadow-panel",
                TOAST_TONE_CLASS[item.tone],
              ].join(" ")}
            >
              {item.message}
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
