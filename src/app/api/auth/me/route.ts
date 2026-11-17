import { okResponse, route } from "@/lib/http";
import { getCurrentUser, hasAnyUser } from "@/modules/auth/service";

export const dynamic = "force-dynamic";

/** 登录页据此决定显示登录还是首次注册；未登录也能调用。 */
export const GET = route(async () => {
  const [user, anyUser] = await Promise.all([getCurrentUser(), hasAnyUser()]);
  return okResponse({ user, hasAnyUser: anyUser });
});
