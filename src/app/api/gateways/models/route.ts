import { okResponse, route } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/modules/auth/service";
import { candidateQuerySchema } from "@/modules/gateway/schema";
import { listCandidateModels } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

/**
 * Agent 候选模型：`GET /api/gateways/models?capability=image`。
 * 能力过滤在服务层完成，`text` 能力的模型不会出现在图片候选里（AC-02-5）。
 * 静态段 `models` 优先于 `[id]`，所以这个路径不会被当成网关 ID。
 */
export const GET = route(async (request) => {
  await requireUser();

  const capability = new URL(request.url).searchParams.get("capability");
  if (!capability) {
    throw AppError.validationFailed("缺少 capability 参数", { code: "CAPABILITY_REQUIRED" });
  }

  const { capability: parsed } = candidateQuerySchema.parse({ capability });
  return okResponse({ models: await listCandidateModels(parsed) });
});
