import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { updateCopyVersionSchema } from "@/modules/copy-generation/schema";
import { updateCopyVersion } from "@/modules/copy-generation/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `PATCH /api/copy-versions/[id]`：编辑当前版本的标题 / 正文 / 标签（原地，不产生新版本）。
 * 「重新生成」走 POST 新建版本（docs/prd/12 MUST NOT）。
 */
export const PATCH = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = updateCopyVersionSchema.parse(await readJson(request));
  return okResponse({ version: await updateCopyVersion(id, input) });
});
