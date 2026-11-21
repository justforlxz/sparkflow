import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { createCopyVersionSchema } from "@/modules/copy-generation/schema";
import { createCopyVersion, listCopyVersions } from "@/modules/copy-generation/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/collections/[id]/copy-versions`：生成文案（docs/prd/12「接口」表）。
 * 每次调用产生一个新版本，只写库并立即返回，执行由 worker 推进（MUST 5）。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = createCopyVersionSchema.parse(await readJson(request));
  return okResponse({ version: await createCopyVersion(id, input) }, 201);
});

/** `GET /api/collections/[id]/copy-versions`：版本列表（倒序）。 */
export const GET = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse({ versions: await listCopyVersions(id) });
});
