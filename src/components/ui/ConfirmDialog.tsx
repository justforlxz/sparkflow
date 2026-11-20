"use client";

import type { ReactNode } from "react";
import { ErrorState } from "./ErrorState";
import { buttonClass, dialogClass, DIALOG_TITLE_CLASS, OVERLAY_CLASS } from "./styles";

/**
 * 二次确认弹窗（docs/prd/09-dashboard.md MUST 4、docs/prd/00-overview.md 全局规则 7）。
 *
 * 只负责「确认 / 取消」这一层：删除、重新生成这类不可撤销或会产生新数据的操作都复用它，
 * 弹窗里的文案与按钮标签由调用方的模块常量给出。
 * `error` 非空时在弹窗内显示后端返回的 `error.message`，调用方不自己拼技术细节。
 * 确认按钮按 `danger` 分成「危险实心红」与「主操作深色实心」两种，取消按钮一律次操作外观。
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
    <div className={OVERLAY_CLASS}>
      <div role="dialog" aria-modal="true" aria-label={title} className={dialogClass({ width: "md" })}>
        <h2 className={DIALOG_TITLE_CLASS}>{title}</h2>
        {body ? <div className="text-body text-ink-secondary">{body}</div> : null}
        {error ? <ErrorState message={error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid={cancelTestId}
            className={buttonClass({ variant: "secondary" })}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid={confirmTestId}
            disabled={busy}
            className={buttonClass({ variant: danger ? "danger" : "primary" })}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
