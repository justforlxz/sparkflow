import { route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { thumbnailWidthSchema } from "@/modules/media-collection/schema";
import { getAssetImage } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ collectionId: string; assetId: string }>;
}

/**
 * 鉴权读取原图字节（MUST 6、AC-01-7）：先校验会话，再按记录找文件，不暴露 `public/`。
 * `?w=400` 当场缩放成缩略图（docs/architecture.md「文件」）。
 */
export const GET = route<Context>(async (request, context) => {
  await requireUser();

  const { collectionId, assetId } = await context.params;
  const width = thumbnailWidthSchema.parse(new URL(request.url).searchParams.get("w") ?? undefined);
  const image = await getAssetImage(collectionId, assetId, width);

  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.bytes.byteLength),
      // 图片内容不随请求变化，但必须经过会话校验才能读到，因此只允许私有缓存。
      "cache-control": "private, max-age=300",
    },
  });
});
