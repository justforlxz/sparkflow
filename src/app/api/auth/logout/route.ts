import { okResponse, route } from "@/lib/http";
import { logoutCurrentSession } from "@/modules/auth/service";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  await logoutCurrentSession();
  return okResponse(null);
});
