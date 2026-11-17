import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { createGatewaySchema } from "@/modules/gateway/schema";
import { createGateway, listGatewayViews } from "@/modules/gateway/service";

// 网关列表与最近一次测试结果都是实时数据，不缓存。
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  return okResponse({ gateways: await listGatewayViews() });
});

export const POST = route(async (request) => {
  await requireUser();
  const input = createGatewaySchema.parse(await readJson(request));
  return okResponse({ gateway: await createGateway(input) }, 201);
});
