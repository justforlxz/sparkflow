import { route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { downloadQuerySchema } from "@/modules/publish/schema";
import { downloadResultAssets } from "@/modules/publish/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * 附件下载的 `Content-Disposition`：ASCII 兜底 + RFC 5987 的 UTF-8 文件名。
 * 中文标题在旧浏览器里退化成下划线，现代浏览器优先用 `filename*`。
 */
function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * `GET /api/results/[id]/download?assets=a,b`（docs/prd/08 接口表）：
 * 选 1 张直接返回图片字节，选多张返回 ZIP；没给 `assets` 时下载全部图片。
 * 文件名与顺序由发布模块决定，这里只负责把字节和响应头拼出去。
 */
export const GET = route<Context>(async (request, context) => {
  await requireUser();

  const { id } = await context.params;
  const raw = new URL(request.url).searchParams.get("assets") ?? "";
  const assets = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const query = downloadQuerySchema.parse({ assets: assets.length > 0 ? assets : undefined });

  const file = await downloadResultAssets(id, query.assets ?? []);
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "content-length": String(file.bytes.byteLength),
      "content-disposition": contentDisposition(file.fileName),
      // 图片必须经过会话校验才能读到，因此只允许私有缓存。
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
});
