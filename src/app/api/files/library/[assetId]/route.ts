import { route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { getLibraryImage } from "@/modules/extraction/service";
import { thumbnailWidthSchema } from "@/modules/media-collection/schema";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ assetId: string }>;
}

/**
 * 鉴权读取素材图片（docs/architecture.md「文件」）：与资源夹原图同一约定，
 * 先校验会话再按记录找文件；`?w=400` 当场缩放成缩略图。
 */
export const GET = route<Context>(async (request, context) => {
  await requireUser();

  const { assetId } = await context.params;
  const width = thumbnailWidthSchema.parse(new URL(request.url).searchParams.get("w") ?? undefined);
  const image = await getLibraryImage(assetId, width);

  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.bytes.byteLength),
      // 图片必须经过会话校验才能读到，因此只允许私有缓存。
      "cache-control": "private, max-age=300",
    },
  });
});
