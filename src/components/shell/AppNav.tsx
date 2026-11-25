"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NAV_ITEMS, isNavActive, type NavBadgeKey, type NavKey } from "./navigation";

/**
 * 侧栏导航（docs/prd/09-dashboard.md MUST 1–3）。
 *
 * 1. 当前项由路径判定并高亮，不靠页面各自传状态。
 * 2. 计数来自 `GET /api/stats`（服务端页面同一份数据），不在组件里算。
 * 3. 窄屏（< 720px）只显示图标：文字用 CSS 隐藏，`aria-label` 保留完整名称，
 *    所以图标模式下导航仍然可点、可被读屏软件读出来。
 */
const ICON_PATHS: Record<NavKey, ReactNode> = {
  dashboard: <path d="M3 10.5 12 3l9 7.5M5.5 9.5V21h13V9.5" />,
  collections: <path d="M4 6.5h6l2 2.5h8V19H4V6.5Z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.3M17.6 15.2l2.2 1.3M4.2 16.5l2.2-1.3M17.6 8.8l2.2-1.3" />
    </>
  ),
};

export interface AppNavProps {
  counts: Record<NavBadgeKey, number>;
}

export function AppNav({ counts }: AppNavProps) {
  const pathname = usePathname() ?? "/";

  return (
    <nav aria-label="主导航" className="flex w-full flex-col gap-1 px-2">
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(item.href, pathname);
        const count = item.badge ? counts[item.badge] : null;

        return (
          <Link
            key={item.key}
            href={item.href}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            data-testid={`nav-${item.key}`}
            className={[
              "flex min-h-10 items-center gap-3 rounded-md px-2.5 text-body transition-colors",
              "justify-center min-[720px]:justify-start",
                          active
                ? "bg-accent-strong font-medium text-on-inverse"
                : "text-ink-secondary hover:bg-soft hover:text-ink",
            ].join(" ")}
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 shrink-0"
            >
              {ICON_PATHS[item.key]}
            </svg>
            <span className="hidden min-[720px]:inline">{item.label}</span>
            {count === null ? null : (
              <span
                data-testid={`nav-count-${item.key}`}
                className={[
                  "hidden rounded-sm px-1.5 py-0.5 text-caption min-[720px]:ml-auto min-[720px]:inline",
                  active ? "bg-on-inverse/20 text-on-inverse" : "bg-soft text-ink-secondary",
                ].join(" ")}
              >
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
