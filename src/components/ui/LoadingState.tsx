/**
 * 加载态（docs/prd/09-dashboard.md MUST 4）。
 *
 * 只在「这块内容正在取数、还没有可显示的数据」时使用，不要盖在已有内容上：
 * 它带 `role="status"`，会和页面其它状态提示一起被读屏软件播报。
 * 转圈只用 150ms 的默认过渡与 `animate-spin`，是状态指示而不是装饰动画。
 */
export interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = "加载中…", className }: LoadingStateProps) {
  const classes = [
    "flex items-center justify-center gap-2 rounded-lg border border-line bg-panel px-4 py-8 text-body text-ink-tertiary",
    className ?? "",
  ]
    .join(" ")
    .trim();

  return (
    <div role="status" className={classes}>
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-ink-secondary"
      />
      <span>{label}</span>
    </div>
  );
}
