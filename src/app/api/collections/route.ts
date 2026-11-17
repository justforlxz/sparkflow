import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { readMultipart } from "@/modules/media-collection/form";
import { collectionFieldsSchema, listCollectionsQuerySchema } from "@/modules/media-collection/schema";
import { createCollection, listCollections } from "@/modules/media-collection/service";

// 资源夹列表随写入变化，不做静态化。
export const dynamic = "force-dynamic";

export const GET = route(async (request) => {
  await requireUser();

  const query = listCollectionsQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return okResponse(await listCollections(query));
});

/** 创建：multipart，字段与至少一张图片一起提交（MUST 1）。 */
export const POST = route(async (request) => {
  await requireUser();

  const { fields, files } = await readMultipart(request);
  const input = collectionFieldsSchema.parse(fields);
  return okResponse(await createCollection(input, files), 201);
});
