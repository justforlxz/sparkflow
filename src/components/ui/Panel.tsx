import type { ReactNode } from "react";

/**
 * 卡片容器（docs/prd/09-dashboard.md MUST 4）：页面上的区块统一用它包一层，
 * 不再各自写 `rounded-lg border border-line bg-panel`。
 *
 * 有 `title` 或 `actions` 时渲染一条带分隔线的标题栏；列表项这类没有标题的卡片
 * 直接用 `children`：卡片自身的外观（圆角 14、边框、底色、唯一的阴影档）只由这里决定，
 * `className` 补外层、`bodyClassName` 补内容层、`padded={false}` 让内容贴边。
 */
export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** 内容区的附加 class（例如列表卡片需要 `flex gap-4` 时补在带内边距的那层上）。 */
  bodyClassName?: string;
  /** 内容区是否带内边距，默认带；图片卡片这类需要内容贴边时传 `false`。 */
  padded?: boolean;
  children?: ReactNode;
}

export function Panel({
  title,
  description,
  actions,
  className,
  bodyClassName,
  padded = true,
  children,
}: PanelProps) {
  const classes = ["rounded-lg border border-line bg-panel shadow-panel", className ?? ""]
    .join(" ")
    .trim();
  const hasHeader = Boolean(title || description || actions);

  return (
    <div className={classes}>
      {hasHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="space-y-0.5">
            {title ? <h2 className="text-heading font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="text-footnote text-ink-tertiary">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children ? (
        <div className={[padded ? "p-4" : "", bodyClassName ?? ""].join(" ").trim()}>{children}</div>
      ) : null}
    </div>
  );
}
