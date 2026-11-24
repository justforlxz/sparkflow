import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { deletePoolAsset } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `DELETE /api/library/assets/[id]`：从总资源库删除一张照片（AC-POOL-7）。
 * 关联行随外键级联删除，磁盘文件一并删除 —— 这是唯一会删原图文件的入口。
 */
export const DELETE = route<Context>(async (_request, context) => {
  await requireUser();

  const { id } = await context.params;
  await deletePoolAsset(id);
  return okResponse({ id });
});
