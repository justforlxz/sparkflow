import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { updateGatewaySchema } from "@/modules/gateway/schema";
import { deleteGateway, updateGateway } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export const PATCH = route<Context>(async (request, context) => {
  await requireUser();
  const { id } = await context.params;
  const input = updateGatewaySchema.parse(await readJson(request));
  return okResponse({ gateway: await updateGateway(id, input) });
});

export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();
  const { id } = await context.params;
  await deleteGateway(id);
  return okResponse({ deleted: id });
});
