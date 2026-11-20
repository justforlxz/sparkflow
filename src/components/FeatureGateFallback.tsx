"use client";

import { useState } from "react";

export interface FeatureGateFallbackProps {
  label: string;
  message: string;
}

/**
 * 功能关闭时的入口占位：显示为不可操作的按钮，点击只提示文案。
 * 这里没有 fetch，也不渲染 children —— 关闭状态下不会发起任何网络请求。
 */
export function FeatureGateFallback({ label, message }: FeatureGateFallbackProps) {
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        aria-disabled="true"
        onClick={() => setNotice(message)}
        className="inline-flex min-h-9 cursor-not-allowed items-center justify-center rounded-md border border-line bg-soft px-3.5 py-1.5 text-body text-ink-tertiary"
      >
        {label}
      </button>
      {notice ? (
        <p role="status" className="text-footnote text-warning">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
