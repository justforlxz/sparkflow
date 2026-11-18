import { okResponse, readJson, route } from "@/lib/http";
import { updateAgentConfigSchema } from "@/modules/agent-config/schema";
import { updateAgent } from "@/modules/agent-config/service";
import { requireUser } from "@/modules/auth/service";
import { listGatewayViews } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ type: string }>;
}

/** `PATCH /api/agents/[type]`：更新一份 Agent 配置（docs/prd/03-agent-config.md 接口表）。 */
export const PATCH = route<Context>(async (request, context) => {
  await requireUser();

  const { type } = await context.params;
  const input = updateAgentConfigSchema.parse(await readJson(request));
  const gateways = await listGatewayViews();

  return okResponse({ agent: await updateAgent(type, input, gateways) });
});
