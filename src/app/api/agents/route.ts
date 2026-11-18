import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { listAgentViews } from "@/modules/agent-config/service";
import { listGatewayViews } from "@/modules/gateway/service";

// Agent 配置是实时设置，不做缓存。
export const dynamic = "force-dynamic";

/**
 * `GET /api/agents`：两份配置 + 绑定信息 + 是否就绪（docs/prd/03-agent-config.md 接口表）。
 * 网关数据由网关模块的 service 提供，路由只做组合。
 */
export const GET = route(async () => {
  await requireUser();
  const gateways = await listGatewayViews();
  return okResponse({ agents: await listAgentViews(gateways) });
});
