import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { parseJsonPart, readMultipart } from "@/modules/media-collection/form";
import {
  collectionEditAssetsSchema,
  collectionFieldsSchema,
} from "@/modules/media-collection/schema";
import { saveCollectionEdit } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

const FILE_PART_PREFIX = "file:";

/**
 * 编辑保存的唯一路径（docs/prd/01-media-collection.md 接口表）：
 * 来源信息与图片变更一次提交，服务端一个事务，失败时整组回滚。
 */
export const POST = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const { fields, files } = await readMultipart(request);

  const filesByTempKey = new Map(
    files
      .filter((file) => file.partName.startsWith(FILE_PART_PREFIX))
      .map((file) => [file.partName.slice(FILE_PART_PREFIX.length), file]),
  );

  return okResponse(
    await saveCollectionEdit(id, {
      fields: parseJsonPart(fields.fields, collectionFieldsSchema, "fields"),
      assets: parseJsonPart(fields.assets, collectionEditAssetsSchema, "assets"),
      files: filesByTempKey,
    }),
  );
});
