import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { createExtractionSchema } from "@/modules/extraction/schema";
import { createExtraction, listExtractionRuns } from "@/modules/extraction/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/collections/[id]/extractions`：发起提取（docs/prd/12「接口」表）。
 * 只写库并立即返回，执行由进程内 worker 推进（MUST 1、SHOULD「创建接口立即返回」）。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = createExtractionSchema.parse(await readJson(request));
  return okResponse({ run: await createExtraction(id, input) }, 201);
});

/** `GET /api/collections/[id]/extractions`：提取运行列表（含进度与失败原因）。 */
export const GET = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse({ runs: await listExtractionRuns(id) });
});
