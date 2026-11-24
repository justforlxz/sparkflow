import { route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { thumbnailWidthSchema } from "@/modules/media-collection/schema";
import { getAssetImage } from "@/modules/media-collection/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ assetId: string }>;
}

/**
 * 鉴权读取原图字节（MUST 6、AC-01-7）：先校验会话，再按记录找文件，不暴露 `public/`。
 * 路径里没有资源夹：照片属于总资源库，一张照片可以同时属于多个夹（ADR 0012 第 1 条）。
 * `?w=400` 当场缩放成缩略图（docs/architecture.md「文件」）。
 */
export const GET = route<Context>(async (request, context) => {
  await requireUser();

  const { assetId } = await context.params;
  const width = thumbnailWidthSchema.parse(new URL(request.url).searchParams.get("w") ?? undefined);
  const image = await getAssetImage(assetId, width);

  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.bytes.byteLength),
      // 图片内容不随请求变化，但必须经过会话校验才能读到，因此只允许私有缓存。
      "cache-control": "private, max-age=300",
    },
  });
});
