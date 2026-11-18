import { okResponse, route } from "@/lib/http";
import { resetAgent } from "@/modules/agent-config/service";
import { requireUser } from "@/modules/auth/service";
import { listGatewayViews } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ type: string }>;
}

/**
 * `POST /api/agents/[type]/reset`：恢复默认文案字段（MUST 7）。
 * 只重置名称、角色说明、系统提示词与输出要求，模型绑定保持不变。
 */
export const POST = route<Context>(async (_request, context) => {
  await requireUser();

  const { type } = await context.params;
  const gateways = await listGatewayViews();

  return okResponse({ agent: await resetAgent(type, gateways) });
});
