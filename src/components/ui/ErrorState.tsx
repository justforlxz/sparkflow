import type { ReactNode } from "react";
import { noticeClass } from "./styles";

/**
 * 错误提示（docs/prd/09-dashboard.md MUST 4、docs/architecture.md 第 4 节）。
 *
 * 只显示后端 `error.message`：调用方不要自己拼状态码、堆栈或技术细节。
 * 需要重试时用 `action` 传入按钮或链接。
 */
export interface ErrorStateProps {
  message: string;
  action?: ReactNode;
  className?: string;
}

export function ErrorState({ message, action, className }: ErrorStateProps) {
  return (
    <div role="alert" className={noticeClass("danger", className)}>
      <p>{message}</p>
      {action ? <div className="flex flex-wrap items-center gap-2 pt-2">{action}</div> : null}
    </div>
  );
}
