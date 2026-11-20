import type { ReactNode } from "react";

/**
 * 空状态（docs/prd/09-dashboard.md MUST 4）：没有数据时给出引导，而不是占位数字或假图片。
 * 内容与后续动作由调用方传入，组件本身不带任何示例数据。
 * 虚线边框 + 白底，让「这里现在什么都没有」和真实卡片区分开。
 */
export interface EmptyStateProps {
  message: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ message, hint, action, className }: EmptyStateProps) {
  const classes = [
    "space-y-2 rounded-lg border border-dashed border-line-strong bg-panel px-6 py-10 text-center",
    className ?? "",
  ]
    .join(" ")
    .trim();

  return (
    <div className={classes}>
      <p className="text-body font-medium text-ink-secondary">{message}</p>
      {hint ? <p className="text-footnote text-ink-tertiary">{hint}</p> : null}
      {action ? <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{action}</div> : null}
    </div>
  );
}
