/**
 * 侧栏导航的唯一登记表（docs/prd/09-dashboard.md MUST 1、MUST 2）。
 *
 * 新增页面时在这里加一项，外壳与「当前项高亮」自动跟上（docs/acceptance.md 第 6 节：
 * 后续节点新增页面走数据驱动注册，不再改 `src/app/(app)/layout.tsx`）。
 *
 * `badge` 指向 `GET /api/stats` 返回的哪一项计数；没有计数的项为 `null`。
 */
export type NavKey = "dashboard" | "collections" | "tasks" | "published" | "settings";

/** 侧栏计数取自统计接口的这两个字段（docs/prd/09 MUST 2、AC-09-5）。 */
export type NavBadgeKey = "collections" | "pendingGeneration";

export interface NavItem {
  key: NavKey;
  href: string;
  label: string;
  badge: NavBadgeKey | null;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", href: "/", label: "工作台", badge: null },
  // 「媒体资源夹」显示资源夹总数，「创作任务」显示待创作数：两者都必须与工作台统计一致（AC-09-5）。
  { key: "collections", href: "/collections", label: "媒体资源夹", badge: "collections" },
  { key: "tasks", href: "/tasks", label: "创作任务", badge: "pendingGeneration" },
  { key: "published", href: "/published", label: "发布记录", badge: null },
  { key: "settings", href: "/settings", label: "模型与 Agent 设置", badge: null },
];

export const SHELL_COPY = {
  brandFull: "拾光 · AI 内容工坊",
  brandShort: "拾光",
  navLabel: "主导航",
  logout: "退出登录",
  logoutShort: "退出",
  currentUserLabel: "当前用户",
} as const;

/** 当前路径是否属于该导航项。`/` 只匹配自己，其余匹配自身与子路径。 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
