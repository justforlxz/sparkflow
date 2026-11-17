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
        className="cursor-not-allowed rounded border border-zinc-300 bg-zinc-100 px-3 py-1.5 text-sm text-zinc-500"
      >
        {label}
      </button>
      {notice ? (
        <p role="status" className="text-xs text-amber-600">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
