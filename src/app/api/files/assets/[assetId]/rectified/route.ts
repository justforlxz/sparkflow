import { route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { thumbnailWidthSchema } from "@/modules/media-collection/schema";
import { getRectifiedImage } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ assetId: string }>;
}

/**
 * 鉴权读取原图的**矫正图**（MKACG-1001）。
 *
 * 与原图同一个鉴权口径，只是多读一份落盘文件：没框选或矫正失败时 404，
 * 界面按 `CollectionAssetView.rectifiedUrl` 是否为 null 决定要不要显示。
 * `?w=400` 当场缩放成缩略图，与 `/api/files/assets/[assetId]` 一致。
 */
export const GET = route<Context>(async (request, context) => {
  await requireUser();

  const { assetId } = await context.params;
  const width = thumbnailWidthSchema.parse(new URL(request.url).searchParams.get("w") ?? undefined);
  const image = await getRectifiedImage(assetId, width);

  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.bytes.byteLength),
      "cache-control": "private, max-age=300",
    },
  });
});
