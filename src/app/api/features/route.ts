import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listFeatures } from "@/modules/feature-flags/service";

// 开关变更立即生效，接口不做缓存。
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  return okResponse({ features: await listFeatures() });
});
