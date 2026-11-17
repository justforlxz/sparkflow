import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { createGatewayModelSchema } from "@/modules/gateway/schema";
import { addGatewayModel } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** 新增模型条目；同一网关内 model_id 唯一（MUST 5）。 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();
  const { id } = await context.params;
  const input = createGatewayModelSchema.parse(await readJson(request));
  return okResponse({ gateway: await addGatewayModel(id, input) }, 201);
});
