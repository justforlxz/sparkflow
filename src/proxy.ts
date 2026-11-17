import { NextResponse, type NextRequest } from "next/server";
import { PATHNAME_HEADER, SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * 只做「有没有会话 cookie」的快速判断，不查数据库（docs/prd/11-accounts.md 的 SHOULD）。
 * 真正的有效性校验在服务端函数 `getCurrentUser()` 里完成。
 */
const PUBLIC_EXACT = new Set(["/login", "/api/health", "/api/auth"]);

function isPublic(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || pathname.startsWith("/api/auth/");
}

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  if (!request.cookies.has(SESSION_COOKIE)) {
    if (isApi(pathname)) {
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "需要登录" } },
        { status: 401 },
      );
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl, 302);
  }

  if (isApi(pathname)) return NextResponse.next();

  // cookie 存在但可能已过期/被撤销：把原路径传给页面层，layout 校验失败时能带上同样的 next。
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATHNAME_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // 静态资源与图片优化不经过登录判定。
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
