import type { ReactNode } from "react";

/**
 * 状态标签（docs/prd/09-dashboard.md MUST 4）。
 *
 * 颜色取自 `globals.css` 的设计变量，语义固定：待处理=蓝、生成中=紫、有结果=橙、完成=绿；
 * 警告与危险复用语义色。tone 名沿用设计变量名（`pendingPublish` / `published`），不代表业务状态。
 * 组件本身不判断业务状态，状态到色板的映射在 `status-tone.ts`，两处都不写颜色字面值（AC-D-1）。
 */
export type PillTone =
  | "neutral"
  | "draft"
  | "generating"
  | "pendingPublish"
  | "published"
  | "warning"
  | "danger";

export const PILL_TONE_CLASS: Record<PillTone, string> = {
  neutral: "bg-soft text-ink-secondary",
  draft: "bg-status-draft-soft text-status-draft",
  generating: "bg-status-generating-soft text-status-generating",
  pendingPublish: "bg-status-pending-publish-soft text-status-pending-publish",
  published: "bg-status-published-soft text-status-published",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  children: ReactNode;
}

export function Pill({ tone = "neutral", className, children, ...rest }: PillProps) {
  const classes = [
    "inline-flex shrink-0 items-center rounded-sm px-2 py-0.5 text-caption font-medium",
    PILL_TONE_CLASS[tone],
  ];
  if (className) classes.push(className);

  return (
    <span className={classes.join(" ")} {...rest}>
      {children}
    </span>
  );
}
