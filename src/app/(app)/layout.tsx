import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/shell/AppNav";
import { SHELL_COPY } from "@/components/shell/navigation";
import { buttonClass } from "@/components/ui/styles";
import { ToastProvider } from "@/components/ui/Toast";
import { PATHNAME_HEADER } from "@/lib/session-cookie";
import { safeNextPath } from "@/modules/auth/redirect";
import { getCurrentUser } from "@/modules/auth/service";
import { getNavCounts } from "@/modules/dashboard/service";
import { logoutAction } from "./actions";

/**
 * 受保护页面共用的外壳（docs/prd/09-dashboard.md「应用外壳」）：
 * 左侧固定侧栏（品牌、导航、当前用户区）+ 右侧内容区；没有有效会话时退回登录页。
 *
 * - `proxy` 已把原路径写进 `PATHNAME_HEADER`，所以「cookie 过期/被撤销」与「根本没有 cookie」
 *   两条路径都带着同样的 `next`。
 * - 导航与计数来自 `NAV_ITEMS` 与 `GET /api/stats` 的同一份数据（`getNavCounts`），
 *   后续节点新增页面只改 `navigation.ts`，不改这个文件（docs/acceptance.md 第 6 节）。
 * - 窄屏（< 720px）侧栏折叠成图标模式，导航仍可点击（MUST 3）。
 * - 新增业务页面放进这个 route group 即可自动受保护。
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user) {
    const requestedPath = (await headers()).get(PATHNAME_HEADER);
    redirect(
      requestedPath
        ? `/login?next=${encodeURIComponent(safeNextPath(requestedPath))}`
        : "/login",
    );
  }

  const counts = await getNavCounts();

  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg">
        <aside
          aria-label="应用侧栏"
          className="fixed inset-y-0 left-0 z-30 flex w-16 flex-col border-r border-line bg-panel min-[720px]:w-60"
        >
          <div className="flex items-center justify-center gap-2 px-3 py-4 min-[720px]:justify-start">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-strong text-body font-semibold text-on-inverse"
            >
              拾
            </span>
            <span className="hidden text-body font-semibold text-ink min-[720px]:inline">
              {SHELL_COPY.brandFull}
            </span>
            <span className="sr-only min-[720px]:hidden">{SHELL_COPY.brandShort}</span>
          </div>

          <AppNav counts={counts} />

          <div className="mt-auto space-y-2 border-t border-line px-3 py-4 text-body">
            <p className="hidden text-caption text-ink-tertiary min-[720px]:block">
              {SHELL_COPY.currentUserLabel}
            </p>
            <p className="truncate text-center font-medium text-ink min-[720px]:text-left">
              {user.name}
            </p>
            <form action={logoutAction}>
              <button
                type="submit"
                className={buttonClass({ variant: "secondary", size: "sm", className: "w-full" })}
              >
                <span className="hidden min-[720px]:inline">{SHELL_COPY.logout}</span>
                <span className="min-[720px]:hidden">{SHELL_COPY.logoutShort}</span>
              </button>
            </form>
          </div>
        </aside>

        <main className="ml-16 min-[720px]:ml-60">
          {/*
            宽度由页面自己定，外壳只给统一的内边距：资源夹详情是 1200px（全站唯一例外，
            ADR 0012 第 4 条），其余页面 1024px。放在外壳里的话，客户端路由切换时
            外层布局不会重新渲染，宽度换不过来。
          */}
          <div className="w-full px-4 py-8 min-[720px]:px-6 min-[720px]:py-10">
            {children}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
