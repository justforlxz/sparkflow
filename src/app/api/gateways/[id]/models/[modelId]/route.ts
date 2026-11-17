import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { removeGatewayModel } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; modelId: string }>;
}

// 路由参数已由 Next 解码，这里不再解码（重复解码会在含 `%` 的模型 ID 上抛 URIError）。
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();
  const { id, modelId } = await context.params;
  return okResponse({ gateway: await removeGatewayModel(id, modelId) });
});
