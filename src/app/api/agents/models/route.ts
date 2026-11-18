import { AppError } from "@/lib/errors";
import { okResponse, route } from "@/lib/http";
import { agentModelQuerySchema } from "@/modules/agent-config/schema";
import { listModelCandidates } from "@/modules/agent-config/service";
import { requireUser } from "@/modules/auth/service";
import { listGatewayViews } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/agents/models?type=image`：该 Agent 可选的模型（docs/prd/03 MUST 2）。
 * 能力过滤在服务层完成，`text` 能力的模型不会出现在图片 Agent 的候选里（AC-03-2）。
 * 静态段 `models` 优先于 `[type]`，所以这个路径不会被当成 Agent 类型。
 */
export const GET = route(async (request) => {
  await requireUser();

  const type = new URL(request.url).searchParams.get("type");
  if (!type) {
    throw AppError.validationFailed("缺少 type 参数", { code: "AGENT_TYPE_REQUIRED" });
  }

  const parsed = agentModelQuerySchema.parse({ type });
  const gateways = await listGatewayViews();

  return okResponse({ models: listModelCandidates(parsed.type, gateways) });
});
