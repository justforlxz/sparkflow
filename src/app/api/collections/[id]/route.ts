import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { collectionFieldsSchema } from "@/modules/media-collection/schema";
import {
  deleteCollection,
  getCollection,
  updateCollectionFields,
} from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  return okResponse(await getCollection(id));
});

/** 编辑来源信息（MUST：只改这些字段，不碰图片）。 */
export const PATCH = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const input = collectionFieldsSchema.parse(await readJson(request));
  return okResponse(await updateCollectionFields(id, input));
});

/** 删除：级联删任务/结果/发布记录，磁盘文件尽力清理（MUST 5）。 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  await deleteCollection(id);
  return okResponse({ id });
});
