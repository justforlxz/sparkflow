import type { ReactNode } from "react";

/**
 * 空状态（docs/prd/09-dashboard.md MUST 4）：没有数据时给出引导，而不是占位数字或假图片。
 * 内容与后续动作由调用方传入，组件本身不带任何示例数据。
 */
export interface EmptyStateProps {
  message: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ message, hint, action, className }: EmptyStateProps) {
  const classes = [
    "space-y-3 rounded border border-dashed border-zinc-300 bg-white px-6 py-10 text-center",
    className ?? "",
  ]
    .join(" ")
    .trim();

  return (
    <div className={classes}>
      <p className="text-sm text-zinc-600">{message}</p>
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
      {action ? <div className="flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
