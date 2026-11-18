import type { ReactNode } from "react";

/**
 * 状态标签（docs/prd/09-dashboard.md MUST 4）。
 *
 * 颜色取自 `globals.css` 的设计变量，语义固定：待创作=蓝、生成中=强调色、待发布=橙、已发布=绿。
 * 组件本身不判断业务状态，状态到色板的映射在 `status-tone.ts`，两处都不写颜色字面值。
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
  neutral: "bg-zinc-100 text-zinc-600",
  draft: "bg-status-draft-soft text-status-draft",
  generating: "bg-status-generating-soft text-status-generating",
  pendingPublish: "bg-status-pending-publish-soft text-status-pending-publish",
  published: "bg-status-published-soft text-status-published",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-danger-soft text-danger",
};

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  children: ReactNode;
}

export function Pill({ tone = "neutral", className, children, ...rest }: PillProps) {
  const classes = ["inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs", PILL_TONE_CLASS[tone]];
  if (className) classes.push(className);

  return (
    <span className={classes.join(" ")} {...rest}>
      {children}
    </span>
  );
}
