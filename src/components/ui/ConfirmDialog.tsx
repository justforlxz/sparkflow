"use client";

import type { ReactNode } from "react";
import { ErrorState } from "./ErrorState";

/**
 * 二次确认弹窗（docs/prd/09-dashboard.md MUST 4、docs/prd/00-overview.md 全局规则 7）。
 *
 * 只负责「确认 / 取消」这一层：删除、重新生成这类不可撤销或会产生新数据的操作都复用它，
 * 弹窗里的文案与按钮标签由调用方的模块常量给出。
 * `error` 非空时在弹窗内显示后端返回的 `error.message`，调用方不自己拼技术细节。
 */
export interface ConfirmDialogProps {
  open: boolean;
  /** 弹窗的可访问名称，同时作为标题显示。 */
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** 危险操作（删除）用红色确认按钮。 */
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
  confirmTestId?: string;
  cancelTestId?: string;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  busyLabel,
  busy = false,
  error,
  danger = false,
  onConfirm,
  onCancel,
  confirmTestId,
  cancelTestId,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
        {body ? <div className="text-sm leading-6 text-zinc-600">{body}</div> : null}
        {error ? <ErrorState message={error} /> : null}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            data-testid={cancelTestId}
            className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid={confirmTestId}
            disabled={busy}
            className={[
              "rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-60",
              danger ? "bg-danger hover:bg-danger/90" : "bg-zinc-900 hover:bg-zinc-700",
            ].join(" ")}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
