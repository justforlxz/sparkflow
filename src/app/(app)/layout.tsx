import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PATHNAME_HEADER } from "@/lib/session-cookie";
import { safeNextPath } from "@/modules/auth/redirect";
import { getCurrentUser } from "@/modules/auth/service";
import { logoutAction } from "./actions";

/**
 * 受保护页面共用的外壳：没有有效会话时退回登录页。
 * proxy 已把原路径写进 `PATHNAME_HEADER`，所以「cookie 过期/被撤销」与「根本没有 cookie」
 * 两条路径都带着同样的 `next`。
 * 新增业务页面放进这个 route group 即可自动受保护。
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

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold text-zinc-900">拾光 · AI 内容工坊</span>
          <div className="flex items-center gap-4 text-sm text-zinc-500">
            <span>{user.name}</span>
            <form action={logoutAction}>
              <button type="submit" className="hover:text-zinc-900">
                退出登录
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
    </div>
  );
}
